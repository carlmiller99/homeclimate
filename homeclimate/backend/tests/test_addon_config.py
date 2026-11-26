"""
Parity test: every option defined in config.yaml must be read via
bashio::config in run.sh.

This catches the class of bug where a new add-on option is added to
config.yaml but the shell entry-point is never updated to read and
export it, so the user's setting silently has no effect at runtime.
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).parents[3]
_CONFIG_YAML = _REPO_ROOT / "homeclimate" / "config.yaml"
_RUN_SH = _REPO_ROOT / "homeclimate" / "run.sh"


def _block_lines(config_yaml: Path, key: str) -> list[str]:
    """Return the raw lines of a top-level block (``options:`` / ``schema:``)
    from a config.yaml, without PyYAML (which is not a project dependency)."""
    lines: list[str] = []
    inside = False
    for line in config_yaml.read_text().splitlines():
        if line.rstrip() == f"{key}:":
            inside = True
            continue
        if inside:
            if line and not line.startswith(" "):
                break  # reached the next top-level key
            lines.append(line.rstrip())
    while lines and not lines[-1]:
        lines.pop()
    return lines


def _option_keys(config_yaml: Path) -> list[str]:
    """Extract keys from the 'options:' block in a config.yaml without PyYAML."""
    keys: list[str] = []
    for line in _block_lines(config_yaml, "options"):
        m = re.match(r"^  (\w+):", line)
        if m:
            keys.append(m.group(1))
    return keys


class TestAddonConfigParity:
    def test_every_option_is_read_by_run_sh(self):
        """Each key under 'options' in config.yaml must have a
        bashio::config '<key>' call or get_config helper call in run.sh,
        otherwise the user's add-on setting is never loaded into the
        process environment."""
        run_sh = _RUN_SH.read_text()
        # Check for either literal bashio::config calls OR get_config helper usage
        missing = [
            key
            for key in _option_keys(_CONFIG_YAML)
            if f"bashio::config '{key}'" not in run_sh and f"get_config '{key}'" not in run_sh
        ]
        assert not missing, (
            f"Option(s) defined in config.yaml but never read in run.sh "
            f"via bashio::config or get_config: {missing}. "
            f"Add a line like: VAR=$(get_config '{missing[0]}' 'default_value')"
        )
