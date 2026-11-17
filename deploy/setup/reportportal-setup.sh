# After-deploy step of the reportportal component (compose.prod.yaml, docs/test-reports.md), run by
# `pnpm run infra` in DEPLOY_PATH, as ReportPortal's superadmin through its own API. Idempotent.
# 1. JUnit import: ReportPortal 5.15.6 installs its JUnit plugin 1.1.0, which rejects every import
#    ("Unrecognized field launchUuid"); 1.1.2 works. Puts 1.1.2 in place, checked by sha256.
# 2. Alerts: creates the "Email Server" integration from the stack's SMTP_URL and MAIL_FROM when
#    there is none, so a project's notification rules can send mail at once.
# The values reach the container on stdin (one per line), never argv or logs.
# ponytail: pinned jar; drop part 1 when an upstream API release ships a working plugin.
set -eu
for k in REPORTPORTAL_ADMIN_PASSWORD SMTP_URL MAIL_FROM; do
  grep "^$k=" .env | cut -d= -f2- | head -1 | grep . || echo
done | docker compose exec -T rp-api python3 -c '
import base64, hashlib, json, sys, urllib.parse, urllib.request
VERSION = "1.1.2"
JAR = f"https://raw.githubusercontent.com/reportportal/plugin-import-junit/{VERSION}/jars/plugin-junit-{VERSION}.jar"
SHA256 = "a525a938576ab8a87cd88fb5e538bf8852ea29d8e6c3edb50370afaf82f2ca95"
pw, smtp, mail_from = (sys.stdin.read().splitlines() + ["", "", ""])[:3]
if not pw:
    sys.exit("REPORTPORTAL_ADMIN_PASSWORD is not set")
form = urllib.parse.urlencode({"grant_type": "password", "username": "superadmin", "password": pw}).encode()
basic = base64.b64encode(b"ui:uiman").decode()
token = json.load(urllib.request.urlopen(urllib.request.Request(
    "http://rp-uat:9999/sso/oauth/token", data=form, headers={"Authorization": "Basic " + basic})))["access_token"]
auth = {"Authorization": "Bearer " + token}
api = "http://127.0.0.1:8585/v1"

def call(path, body=None, method=None, headers=None):
    req = urllib.request.Request(api + path, data=body, method=method, headers={**auth, **(headers or {})})
    return json.load(urllib.request.urlopen(req))

plugins = call("/plugin")
if any(p["name"] == "junit" and p.get("details", {}).get("version") == VERSION for p in plugins):
    print(f"  reportportal: JUnit import plugin {VERSION} in place")
else:
    jar = urllib.request.urlopen(JAR).read()
    if hashlib.sha256(jar).hexdigest() != SHA256:
        sys.exit("reportportal: JUnit plugin jar checksum mismatch, not installed")
    b = "rpjunitplugin"
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"plugin-junit-{VERSION}.jar\"\r\n"
            "Content-Type: application/java-archive\r\n\r\n").encode() + jar + f"\r\n--{b}--\r\n".encode()
    call("/plugin", body, "POST", {"Content-Type": f"multipart/form-data; boundary={b}"})
    print(f"  reportportal: JUnit import plugin {VERSION} installed")

# The notification runner looks the integration up by this exact name.
if any(i.get("name") == "Email Server" for i in call("/integration/global/all/email")):
    print("  reportportal: email server in place")
elif not smtp or not mail_from:
    print("  reportportal: no SMTP_URL/MAIL_FROM, email alerts not set up")
else:
    u = urllib.parse.urlsplit(smtp)
    tls = urllib.parse.parse_qs(u.query).get("tls", [""])[0]
    params = {
        "host": u.hostname, "port": u.port or (465 if u.scheme == "smtps" else 587), "protocol": "smtp",
        "from": mail_from, "sslEnabled": u.scheme == "smtps",
        "starTlsEnabled": u.scheme == "smtp" and tls != "none", "authEnabled": bool(u.username),
    }
    if u.username:
        params |= {"username": urllib.parse.unquote(u.username), "password": urllib.parse.unquote(u.password or "")}
    call("/integration/email", json.dumps({"name": "Email Server", "enabled": True, "integrationParameters": params}).encode(),
         "POST", {"Content-Type": "application/json"})
    print("  reportportal: email server set up from SMTP_URL")
'
