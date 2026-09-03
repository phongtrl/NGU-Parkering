import requests
requests.packages.urllib3.disable_warnings()

TOKEN = "slusen_9y6ZMVizWskAJ7Mt9RlZgzK9NHW_Bp7XdqX_3-Ddan0"
BASE = "https://slusen.ngu.no"
SLUG = "ngu-parkering"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# 1) Optional token/list check — NON-FATAL (older servers may 404 here; ignore it)
try:
    r = requests.get(f"{BASE}/api/v2/pages/deploy", headers=HEADERS, verify=False)
    if r.status_code == 200:
        print("Connection OK — token scoped to:", [p["slug"] for p in r.json()])
    else:
        print(f"(list route returned {r.status_code} — ignoring, using page endpoint instead)")
except Exception as e:
    print(f"(list route error — ignoring: {e})")

# 2) Real check — inspect current contents of THIS page (this must work)
r = requests.get(f"{BASE}/api/v2/pages/deploy/{SLUG}", headers=HEADERS, verify=False)
if r.status_code == 401:
    print("❌ Token rejected for this page — check the token.")
elif r.status_code == 404:
    print(f"✅ Connected. Page '{SLUG}' does not exist yet — nothing deployed.")
else:
    r.raise_for_status()
    p = r.json()
    print(f"✅ Connected. Page exists: {p.get('title')}")
    print("HTML bytes:", len(p.get("html") or ""))
    print("Has CSS:", bool(p.get("css")), "| Has JS:", bool(p.get("js")))
    print("Assets:", [a["filename"] for a in p.get("assets", [])] or "(none)")
