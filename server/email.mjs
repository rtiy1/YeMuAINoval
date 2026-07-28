const configuredProvider = String(process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : process.env.NODE_ENV === 'production' ? 'disabled' : 'console')).trim().toLowerCase()
const supportedProviders = new Set(['disabled', 'console', 'resend', 'test'])

if (!supportedProviders.has(configuredProvider)) {
  throw new Error('EMAIL_PROVIDER must be disabled, console, or resend')
}
if (process.env.NODE_ENV === 'production' && ['console', 'test'].includes(configuredProvider)) {
  throw new Error(`${configuredProvider} email provider cannot be used in production`)
}

export const emailConfig = Object.freeze({
  provider: configuredProvider,
  configured: configuredProvider === 'resend'
    ? Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
    : configuredProvider !== 'disabled',
})

let warnedDisabled = false

function disabledDelivery() {
  if (!warnedDisabled) {
    warnedDisabled = true
    console.warn('Account email delivery is disabled. Configure EMAIL_PROVIDER=resend, RESEND_API_KEY, and EMAIL_FROM.')
  }
  return { delivered: false, provider: configuredProvider }
}

function resetEmailText(name, resetUrl, expiresInMinutes) {
  return [
    `${name || '你好'}：`,
    '',
    '我们收到了重置叙事工坊账号密码的请求。',
    `请在 ${expiresInMinutes} 分钟内打开下面的链接并设置新密码：`,
    resetUrl,
    '',
    '如果这不是你的操作，可以忽略这封邮件；你的密码不会发生变化。',
  ].join('\n')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function resetEmailHtml(name, resetUrl, expiresInMinutes) {
  const safeName = escapeHtml(name || '你好')
  const safeUrl = escapeHtml(resetUrl)
  return `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.7;color:#252925;max-width:560px;margin:auto">
    <h1 style="font-size:22px">重置叙事工坊密码</h1>
    <p>${safeName}：</p>
    <p>我们收到了重置你账号密码的请求。请在 ${expiresInMinutes} 分钟内设置新密码。</p>
    <p><a href="${safeUrl}" style="display:inline-block;padding:11px 18px;background:#252925;color:#fff;text-decoration:none;border-radius:5px">设置新密码</a></p>
    <p style="font-size:13px;color:#777">如果按钮无法打开，请复制此链接：<br><a href="${safeUrl}">${safeUrl}</a></p>
    <p style="font-size:13px;color:#777">如果这不是你的操作，可以忽略这封邮件；你的密码不会发生变化。</p>
  </div>`
}

async function sendResendEmail({ to, subject, text, html, idempotencyKey }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error('Resend email delivery requires RESEND_API_KEY and EMAIL_FROM')
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Resend rejected account email with status ${response.status}`)
  const payload = await response.json()
  return { delivered: true, provider: configuredProvider, id: payload.id }
}

export async function sendPasswordResetEmail({ to, name, resetUrl, expiresInMinutes, idempotencyKey }) {
  if (configuredProvider === 'disabled') {
    return disabledDelivery()
  }

  if (configuredProvider === 'console') {
    console.info(`Password reset link for ${to}: ${resetUrl}`)
    return { delivered: true, provider: configuredProvider }
  }

  if (configuredProvider === 'test') {
    return { delivered: true, provider: configuredProvider }
  }

  return sendResendEmail({
    to,
    subject: '重置你的叙事工坊密码',
    text: resetEmailText(name, resetUrl, expiresInMinutes),
    html: resetEmailHtml(name, resetUrl, expiresInMinutes),
    idempotencyKey: `password-reset/${idempotencyKey}`,
  })
}

export async function sendRegistrationVerificationEmail({ to, code, expiresInMinutes, idempotencyKey }) {
  if (configuredProvider === 'disabled') return disabledDelivery()
  if (configuredProvider === 'console') {
    console.info(`Registration verification code for ${to}: ${code}`)
    return { delivered: true, provider: configuredProvider }
  }
  if (configuredProvider === 'test') return { delivered: true, provider: configuredProvider }

  const safeCode = escapeHtml(code)
  return sendResendEmail({
    to,
    subject: '你的叙事工坊注册验证码',
    text: `你的叙事工坊注册验证码是：${code}\n\n验证码将在 ${expiresInMinutes} 分钟后失效。若非本人操作，请忽略这封邮件。`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.7;color:#252925;max-width:560px;margin:auto">
      <h1 style="font-size:22px">验证你的邮箱</h1>
      <p>在注册页面输入下面的 6 位验证码：</p>
      <p style="font:700 30px ui-monospace,monospace;letter-spacing:8px">${safeCode}</p>
      <p style="font-size:13px;color:#777">验证码将在 ${expiresInMinutes} 分钟后失效。若非本人操作，请忽略这封邮件。</p>
    </div>`,
    idempotencyKey: `registration-code/${idempotencyKey}`,
  })
}
