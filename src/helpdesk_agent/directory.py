"""The fake company directory: users, groups, devices and apps.

Loaded from packaged synthetic JSON into memory. Writes (MFA resets, group adds) change
only this in-memory copy, never the file.
"""

from __future__ import annotations

import copy
import json
import unicodedata
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any

PRIVILEGED_NAME_MARKERS = ("admin", "root", "privileged", "super", "approver", "owner")


def normalize(value: str) -> str:
    """Canonical form for lookups: NFKC, invisible format characters removed, whitespace
    trimmed and collapsed, casefolded.

    Lookups are exact matches on this form, so look-alike or padded names either resolve
    to the real record or to nothing. They never resolve to something unexpected.
    """
    text = unicodedata.normalize("NFKC", value)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    return " ".join(text.split()).casefold()


def scripts_in(value: str) -> set[str]:
    """The Unicode scripts of the letters in ``value``, after NFKC (e.g. {"LATIN"}).

    Used to reject names that mix scripts, such as "admins" spelled with a Cyrillic letter a.
    The script is the first word of each letter's Unicode name, which is close enough to
    the real Script property for the alphabets a look-alike attack would use.
    """
    found = set()
    for ch in unicodedata.normalize("NFKC", value):
        if ch.isalpha():
            found.add(unicodedata.name(ch, "UNKNOWN").split()[0])
    return found


@dataclass
class Directory:
    company: str
    users: dict[str, dict[str, Any]]
    groups: dict[str, dict[str, Any]]
    devices: list[dict[str, Any]]
    apps: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | None = None) -> Directory:
        if path is None:
            raw = resources.files("helpdesk_agent").joinpath("data/directory.json").read_text()
        else:
            raw = path.read_text()
        data = json.loads(raw)
        return cls(
            company=data["company"],
            users={normalize(u["email"]): copy.deepcopy(u) for u in data["users"]},
            groups={normalize(g["name"]): copy.deepcopy(g) for g in data["groups"]},
            devices=copy.deepcopy(data["devices"]),
            apps=copy.deepcopy(data.get("apps", [])),
        )

    def find_user(self, email: str) -> dict[str, Any] | None:
        return self.users.get(normalize(email))

    def find_group(self, name: str) -> dict[str, Any] | None:
        return self.groups.get(normalize(name))

    def devices_for(self, email: str) -> list[dict[str, Any]]:
        key = normalize(email)
        return [d for d in self.devices if normalize(d["owner"]) == key]

    def is_privileged_group(self, name: str) -> bool:
        """True if the group is flagged privileged or its name looks privileged.

        The name check is a second layer so a mislabelled group still fails closed.
        """
        group = self.find_group(name)
        if group is not None and group.get("privileged", False):
            return True
        key = normalize(name)
        return any(marker in key for marker in PRIVILEGED_NAME_MARKERS)

    def privileged_memberships(self, user: dict[str, Any]) -> list[str]:
        return [g for g in user.get("groups", []) if self.is_privileged_group(g)]
