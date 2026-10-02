"""Measure downloaded Pocket teacher/student exports on CPU, entirely offline.

Run with --plan-only before the selected exports are used. This script does not
access Kaggle, credentials, the game, or production voice settings.
"""

from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

from pocket_training.compare_exports import main


if __name__ == "__main__":
    raise SystemExit(main())
