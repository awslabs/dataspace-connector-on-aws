"""Pytest configuration for the Dataspace Connector MCP server tests.

Sets a deterministic environment BEFORE server.py is imported (its config is read
at import time) and ensures the server module is importable from the tests dir.
"""

import os
import sys

# Deterministic config: single-connector base URL, no IAM signing, no API key.
os.environ.setdefault("EDC_MANAGEMENT_URL", "http://test.local/management")
os.environ.pop("EDC_USE_AWS_IAM", None)
os.environ.pop("EDC_MULTI_CONNECTOR", None)
os.environ.pop("EDC_API_KEY", None)

sys.path.insert(0, os.path.dirname(__file__))
