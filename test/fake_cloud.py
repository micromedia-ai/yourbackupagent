#!/usr/bin/env python3
"""Stand-in for `gcloud` and `curl` in backup-kit/test/run.sh.

Buckets are folders under $FAKE_GCS; Google APIs answer canned JSON shaped
like the real ones. Every call is appended to $FAKE_GCS/../calls.log so the
tests can check what the script did (and did not) touch.
"""
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(os.environ["FAKE_GCS"])
LOG = ROOT.parent / "calls.log"
PROJECT = os.environ.get("FAKE_PROJECT", "demo-app")


def log(line):
    with open(LOG, "a") as f:
        f.write(line + "\n")


def local(gs):
    assert gs.startswith("gs://"), gs
    return ROOT / gs[5:]


def files_under(p):
    if p.is_file():
        return [p]
    return sorted(x for x in p.rglob("*") if x.is_file()) if p.exists() else []


# ---------------------------------------------------------------- gcloud
def gcloud(args):
    args = [a for a in args if not a.startswith("--account=")]
    log("gcloud " + " ".join(args))
    flags = [a for a in args if a.startswith("--")]
    pos = [a for a in args if not a.startswith("-")]
    head = " ".join(pos[:3])
    if pos[:3] == ["config", "get-value", "account"]:
        print("owner@example.com")
        return 0
    if pos[:2] == ["auth", "print-access-token"]:
        if any(f.startswith("--scopes") for f in flags):
            return 1  # a person's login cannot ask for extra scopes
        print("fake-token")
        return 0
    if pos[:2] == ["projects", "update"] and any(f.startswith(("--update-labels", "--clear-labels")) for f in flags):
        print("ERROR: (gcloud.projects.update) unrecognized arguments: (labels are alpha-only)", file=sys.stderr)
        return 2
    if pos[:2] == ["projects", "describe"]:
        if "projectNumber" in " ".join(flags):
            print("123456")
        elif "json" in " ".join(flags):
            print(json.dumps({"projectId": pos[2], "labels": json.loads(os.environ.get("FAKE_LABELS", "{}"))}))
        else:
            print(pos[2])
        return 0
    if pos[:3] == ["storage", "buckets", "describe"]:
        p = local(pos[3])
        if not p.is_dir():
            return 1
        if "json" in " ".join(flags):
            print(json.dumps({"name": pos[3][5:], "location": "US"}))
        elif "project_number" in " ".join(flags):
            print("123456")
        else:
            print(pos[3][5:])
        return 0
    if pos[:3] == ["storage", "buckets", "create"]:
        local(pos[3]).mkdir(parents=True, exist_ok=True)
        return 0
    if pos[:2] == ["storage", "rsync"]:
        src, dst = local(pos[2]), local(pos[3])
        for f in files_under(src):
            t = dst / f.relative_to(src)
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(f, t)
            print(f"Copying {pos[2]}/{f.relative_to(src)} to {pos[3]}/{f.relative_to(src)}", file=sys.stderr)
        return 0
    if pos[:3] == ["storage", "objects", "list"]:
        p = local(pos[3].removesuffix("/**"))
        for f in files_under(p):
            print(str(f.relative_to(ROOT)).split("/", 1)[1])
        return 0
    if pos[:2] == ["storage", "ls"]:
        p = local(pos[2].rstrip("/"))
        if not p.exists():
            return 1
        if p.is_file():
            print(pos[2])
            return 0
        for c in sorted(p.iterdir()):
            print("gs://" + str(c.relative_to(ROOT)) + ("/" if c.is_dir() else ""))
        return 0
    if pos[:2] == ["storage", "cat"]:
        p = local(pos[2])
        if not p.is_file():
            return 1
        sys.stdout.write(p.read_text())
        return 0
    if pos[:2] == ["storage", "du"]:
        p = local(pos[2])
        print(sum(f.stat().st_size for f in files_under(p)), pos[2])
        return 0
    if pos[:2] == ["storage", "cp"]:
        srcs, dst = pos[2:-1], pos[-1]
        for s in srcs:
            if s.startswith("gs://"):
                sp = local(s.rstrip("*").rstrip("/"))
                items = list(sp.iterdir()) if s.endswith("/*") else [sp]
                if not any(i.exists() for i in items):
                    return 1
            else:
                items = [Path(s)]
            for it in items:
                if dst.startswith("gs://"):
                    base = local(dst)
                    target = base / it.name if dst.endswith("/") else base
                else:
                    target = Path(dst) / it.name if Path(dst).is_dir() else Path(dst)
                if it.is_dir():
                    for f in files_under(it):
                        t = target / f.relative_to(it)
                        t.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy(f, t)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy(it, target)
        return 0
    if pos[:2] == ["storage", "rm"]:
        p = local(pos[2].removesuffix("/**"))
        if not p.exists():
            return 1
        for f in files_under(p):
            f.unlink()
        if "-r" in sys.argv and p.is_dir():
            shutil.rmtree(p)
        return 0
    if pos[:3] == ["firestore", "backups", "list"] or pos[:4] == ["firestore", "backups", "schedules", "list"]:
        print("[]")
        return 0
    if pos[:3] == ["firestore", "databases", "list"]:
        return 0
    if pos[:2] == ["iam", "service-accounts"]:
        print("github-deploy@demo-app.iam.gserviceaccount.com")
        return 0
    if pos[:2] == ["projects", "get-iam-policy"]:
        print(json.dumps({"bindings": [{"role": "roles/owner", "members": ["serviceAccount:old-ci@other.iam.gserviceaccount.com", "user:owner@example.com"]}]}))
        return 0
    if pos[:2] == ["billing", "projects"]:
        print("True")
        return 0
    if pos[:3] == ["secrets", "versions", "access"]:
        return 1
    if pos[:2] in (["secrets", "list"], ["secrets", "describe"]):
        return 1 if pos[1] == "describe" else 0
    if pos[:2] == ["kms", "keyrings"] or pos[:2] == ["kms", "keys"]:
        return 1 if pos[2] == "describe" else 0
    # Everything else (IAM bindings, enables, updates, creates, liens): succeed quietly.
    return 0


# ---------------------------------------------------------------- curl
USERS = [
    {"localId": "u1", "email": "a@example.com", "emailVerified": True, "passwordHash": "aGFzaA==", "salt": "c2FsdA==",
     "passwordUpdatedAt": 1700000000000, "createdAt": "1700000000000", "lastLoginAt": "1700000001000",
     "customAttributes": "{\"admin\":true}", "validSince": "1700000000", "lastRefreshAt": "2026-01-01T00:00:00Z",
     "providerUserInfo": [{"providerId": "password", "federatedId": "a@example.com", "email": "a@example.com", "rawId": "a@example.com"}]},
    {"localId": "u2", "email": "b@example.com", "displayName": "B", "createdAt": "1700000000000",
     "providerUserInfo": [{"providerId": "google.com", "rawId": "1234", "federatedId": "1234", "email": "b@example.com", "displayName": "B"}]},
    {"localId": "u3", "email": "c@example.com", "emailLinkSignin": True, "createdAt": "1700000000000",
     "providerUserInfo": [{"providerId": "password", "email": "c@example.com", "rawId": "c@example.com"}]},
]
COUNTS = {"users": 5, "polls": 3}


def curl(args):
    method, data, url, i = "GET", "", None, 0
    while i < len(args):
        a = args[i]
        if a == "-X":
            method = args[i + 1]; i += 2; continue
        if a in ("--data", "-d"):
            data = args[i + 1]; i += 2; continue
        if a in ("-H", "-w", "--max-time", "-o"):
            i += 2; continue
        if a.startswith("http"):
            url = a
        i += 1
    log(f"curl {method} {url}")
    status, body = route(method, url, json.loads(data) if data else {})
    sys.stdout.write(json.dumps(body) + "\n" + str(status))
    return 0


def route(method, url, data):
    fail = os.environ.get("FAKE_FAIL", "")
    if fail and re.search(fail, url):
        return 403, {"error": {"message": "fake permission denied"}}
    if url.endswith(":exportDocuments"):
        out = local(data["outputUriPrefix"])
        out.mkdir(parents=True, exist_ok=True)
        (out / (out.name + ".overall_export_metadata")).write_text("meta")
        (out / "all_namespaces").mkdir(exist_ok=True)
        (out / "all_namespaces" / "output-0").write_text("docs")
        return 200, {"name": "projects/x/databases/(default)/operations/export1"}
    if url.endswith(":importDocuments"):
        return 200, {"name": "projects/x/databases/(default)/operations/import1"}
    if "/operations/" in url:
        return 200, {"done": True}
    if url.endswith(":listCollectionIds"):
        return 200, {"collectionIds": sorted(COUNTS)}
    if url.endswith(":runAggregationQuery"):
        c = data["structuredAggregationQuery"]["structuredQuery"]["from"][0]["collectionId"]
        return 200, [{"result": {"aggregateFields": {"n": {"integerValue": str(COUNTS[c])}}}}]
    if re.search(r"/projects/[^/]+/databases$", url):
        return 200, {"databases": [{"name": "projects/x/databases/(default)"}, {"name": "projects/x/databases/drill-202601010000"}]}
    if re.search(r"/databases/[^/:]+$", url) and method == "GET":
        if "drill" in url and os.environ.get("FAKE_DRILL_DB_EXISTS") != "1":
            return 404, {"error": {"message": "not found"}}
        return 200, {"name": url, "locationId": "nam5", "pointInTimeRecoveryEnablement": "POINT_IN_TIME_RECOVERY_ENABLED",
                     "deleteProtectionState": "DELETE_PROTECTION_ENABLED"}
    if "firebasestorage.googleapis.com" in url and url.endswith("/buckets"):
        p = re.search(r"projects/([^/]+)/", url).group(1)
        return 200, {"buckets": [{"name": f"projects/{p}/buckets/{p}.firebasestorage.app"}]}
    if "firebasedatabase.googleapis.com" in url:
        return 200, {}
    if "accounts:batchGet" in url:
        return 200, {"users": USERS}
    if url.endswith("/config") and "identitytoolkit" in url and method == "GET":
        return 200, {"signIn": {"email": {"enabled": True}, "hashConfig": {"algorithm": "SCRYPT", "signerKey": "a2V5", "saltSeparator": "Bw==", "rounds": 8, "memoryCost": 14}},
                     "client": {"apiKey": "AIza-secret"}}
    if "accounts:batchCreate" in url:
        Path(LOG.parent / "batchCreate.json").write_text(json.dumps(data))
        return 200, {}
    if "cloudresourcemanager.googleapis.com/v3/projects/" in url:
        if method == "PATCH":
            with open(LOG.parent / "labels.log", "a") as f:
                f.write(json.dumps(data.get("labels", {}), sort_keys=True) + "\n")
            return 200, {"name": "operations/labels", "done": True}
        return 200, {"labels": json.loads(os.environ.get("FAKE_LABELS", "{}"))}
    if "secretmanager" in url:
        return 200, {"secrets": [{"name": "projects/x/secrets/RESEND_API_KEY"}, {"name": "projects/x/secrets/EVM_RELAYER_KEY"}]}
    return 200, {}


if __name__ == "__main__":
    tool = os.path.basename(sys.argv[1])
    sys.exit(gcloud(sys.argv[2:]) if tool == "gcloud" else curl(sys.argv[2:]))
