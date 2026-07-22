import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.schemas import SkillDescriptor


SKILL_NAME_PATTERN = re.compile(r'^[a-z0-9-]+$')
ALLOWED_REFERENCES = {
    'story-review': {
        'quality-checklist.md',
        'quality-rubric.md',
        'banned-words.md',
        'anti-ai-writing.md',
        'rubrics/fanqie.md',
        'rubrics/qidian.md',
        'rubrics/zhihu.md',
    },
}
ALLOWED_SCRIPTS = {
    'story-review': {
        'normalize-punctuation.js',
        'check-ai-patterns.js',
        'check-degeneration.js',
    },
}


class SkillRegistryError(RuntimeError):
    pass


@dataclass(frozen=True)
class SkillPackage:
    name: str
    version: str | None
    description: str
    root: Path
    instructions: str


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

    def read_reference(self, skill_name: str, relative_path: str) -> str:
        if relative_path not in ALLOWED_REFERENCES.get(skill_name, set()):
            raise SkillRegistryError(f'reference is not allowed for {skill_name}: {relative_path}')
        target = self._inside_root(self._skill_dir(skill_name) / 'references' / relative_path)
        if not target.is_file():
            raise SkillRegistryError(f'reference is missing: {relative_path}')
        return target.read_text(encoding='utf-8')

    def script_path(self, skill_name: str, script_name: str) -> Path:
        if script_name not in ALLOWED_SCRIPTS.get(skill_name, set()):
            raise SkillRegistryError(f'script is not allowed for {skill_name}: {script_name}')
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
                package = self.load(name)
                executor = executors.get(name)
                override = (status_overrides or {}).get(name)
                descriptors.append(SkillDescriptor(
                    name=name,
                    version=package.version,
                    description=package.description,
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
