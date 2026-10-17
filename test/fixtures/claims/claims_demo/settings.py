import os

API_URL = os.environ.get("CLAIMS_API_URL", "http://localhost:8080")
TIMEOUT = float(os.getenv("CLAIMS_TIMEOUT", "5"))
