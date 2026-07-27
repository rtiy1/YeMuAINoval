import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.schemas import SkillDescriptor


SKILL_NAME_PATTERN = re.compile(r'^[a-z0-9-]+$')
# references/ 下允许读取的扩展名（白名单，防止读到 scripts 或二进制）
REFERENCE_SUFFIXES = ('.md', '.txt')
# scripts/ 下允许执行的扩展名
SCRIPT_SUFFIX = '.js'


class SkillRegistryError(RuntimeError):
    pass


@dataclass(frozen=True)
class SkillPackage:
    name: str
    version: str | None
    description: str
    root: Path
    instructions: str


@dataclass(frozen=True)
class SkillMetadata:
    name: str
    version: str | None
    description: str
    root: Path


class SkillRegistry:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()

    def _inside_root(self, path: Path) -> Path:
        resolved = path.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise SkillRegistryError('skill path escapes the configured root')
        return resolved

    def _skill_dir(self, name: str) -> Path:
        if not SKILL_NAME_PATTERN.fullmatch(name):
            raise SkillRegistryError(f'invalid skill name: {name}')
        return self._inside_root(self.root / name)

    def load(self, name: str) -> SkillPackage:
        skill_dir = self._skill_dir(name)
        skill_file = self._inside_root(skill_dir / 'SKILL.md')
        if not skill_file.is_file():
            raise SkillRegistryError(f'skill is not installed: {name}')
        instructions = skill_file.read_text(encoding='utf-8')
        metadata = parse_frontmatter(instructions)
        manifest_name = metadata.get('name', name)
        if manifest_name != name:
            raise SkillRegistryError(f'skill manifest name mismatch: {name}')
        return SkillPackage(
            name=name,
            version=metadata.get('version'),
            description=metadata.get('description', ''),
            root=skill_dir,
            instructions=instructions,
        )

    def describe(self, name: str) -> SkillMetadata:
        """只读取 Skill frontmatter，不加载完整契约正文。

        能力发现和路由阶段只需要 name/version/description。完整 SKILL.md
        必须等具体 Skill 被选中执行时再由 ``load`` 读取。
        """
        skill_dir = self._skill_dir(name)
        skill_file = self._inside_root(skill_dir / 'SKILL.md')
        if not skill_file.is_file():
            raise SkillRegistryError(f'skill is not installed: {name}')
        frontmatter_lines: list[str] = []
        with skill_file.open('r', encoding='utf-8') as handle:
            first = handle.readline()
            if first.strip() == '---':
                frontmatter_lines.append(first)
                for line in handle:
                    frontmatter_lines.append(line)
                    if line.strip() == '---':
                        break
                    if sum(len(item) for item in frontmatter_lines) > 64_000:
                        raise SkillRegistryError(f'skill frontmatter is too large: {name}')
        metadata = parse_frontmatter(''.join(frontmatter_lines))
        manifest_name = metadata.get('name', name)
        if manifest_name != name:
            raise SkillRegistryError(f'skill manifest name mismatch: {name}')
        return SkillMetadata(
            name=name,
            version=metadata.get('version'),
            description=metadata.get('description', '')[:1000],
            root=skill_dir,
        )

    def read_reference(self, skill_name: str, relative_path: str) -> str:
        """读取 skill references/ 下的任意 .md/.txt 文件。

        自动允许该 skill 目录下的 references 子树，不再逐文件白名单；
        通过 _inside_root 防止路径逃逸，通过扩展名限制防止读到非文本资产。

        relative_path 可带或不带 ``references/`` 前缀，两种写法等价。
        """
        clean = relative_path.replace('\\', '/').lstrip('/')
        if clean.startswith('references/'):
            clean = clean[len('references/'):]
        if not clean or Path(clean).is_absolute() or '..' in Path(clean).parts:
            raise SkillRegistryError(f'reference path is not allowed for {skill_name}: {relative_path}')
        if not clean.endswith(REFERENCE_SUFFIXES):
            raise SkillRegistryError(f'reference extension is not allowed for {skill_name}: {relative_path}')
        target = self._inside_root(self._skill_dir(skill_name) / 'references' / clean)
        if not target.is_file():
            raise SkillRegistryError(f'reference is missing: {relative_path}')
        return target.read_text(encoding='utf-8')

    def reference_exists(self, skill_name: str, relative_path: str) -> bool:
        """安全检查 reference 是否存在，不抛异常。"""
        clean = relative_path.replace('\\', '/').lstrip('/')
        if clean.startswith('references/'):
            clean = clean[len('references/'):]
        try:
            return self._inside_root(self._skill_dir(skill_name) / 'references' / clean).is_file()
        except (OSError, SkillRegistryError):
            return False

    def script_path(self, skill_name: str, script_name: str) -> Path:
        """返回 skill scripts/ 下的 .js 脚本路径。

        自动允许该 skill 目录下的 scripts 子树，不再逐文件白名单；
        通过 _inside_root 防止路径逃逸，通过扩展名限制只允许 .js。
        """
        if not script_name or Path(script_name).is_absolute() or '..' in Path(script_name).parts:
            raise SkillRegistryError(f'script path is not allowed for {skill_name}: {script_name}')
        if not script_name.endswith(SCRIPT_SUFFIX):
            raise SkillRegistryError(f'script extension is not allowed for {skill_name}: {script_name}')
        target = self._inside_root(self._skill_dir(skill_name) / 'scripts' / script_name)
        if not target.is_file():
            raise SkillRegistryError(f'script is missing: {script_name}')
        return target

    def catalog(self, executors: dict[str, str], status_overrides: dict[str, str] | None = None) -> list[SkillDescriptor]:
        if not self.root.is_dir():
            return []
        descriptors: list[SkillDescriptor] = []
        for skill_file in sorted(self.root.glob('*/SKILL.md')):
            name = skill_file.parent.name
            try:
                metadata = self.describe(name)
                executor = executors.get(name)
                override = (status_overrides or {}).get(name)
                descriptors.append(SkillDescriptor(
                    name=name,
                    version=metadata.version,
                    description=metadata.description,
                    status=override or ('ready' if executor else 'registered'),
                    executor=executor,
                ))
            except (OSError, SkillRegistryError, UnicodeError):
                descriptors.append(SkillDescriptor(name=name, description='', status='unavailable'))
        return descriptors


def parse_frontmatter(document: str) -> dict[str, str]:
    lines = document.splitlines()
    if not lines or lines[0].strip() != '---':
        return {}
    metadata: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == '---':
            break
        if ':' not in line:
            continue
        key, raw_value = line.split(':', 1)
        key = key.strip()
        value = raw_value.strip()
        if not key or key == 'metadata':
            continue
        if value.startswith(('"', "'")):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = value.strip('"\'')
        metadata[key] = str(value)
    return metadata


@lru_cache
def get_skill_registry() -> SkillRegistry:
    return SkillRegistry(get_settings().story_skills_root)
