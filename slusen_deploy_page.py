import requests
from pathlib import Path

requests.packages.urllib3.disable_warnings()

TOKEN = "slusen_9y6ZMVizWskAJ7Mt9RlZgzK9NHW_Bp7XdqX_3-Ddan0"
BASE = "https://slusen.ngu.no"
SLUG = "ngu-parkering"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

here = Path(__file__).parent
html = (here / "index.html").read_text(encoding="utf-8")
css = (here / "styles.css").read_text(encoding="utf-8")
js = (here / "app.js").read_text(encoding="utf-8")

# Inline CSS and JS into a single self-contained document.
html = html.replace(
    '<link rel="stylesheet" href="styles.css">',
    f"<style>\n{css}\n</style>",
)
html = html.replace(
    '<script src="app.js"></script>',
    f"<script>\n{js}\n</script>",
)

r = requests.put(
    f"{BASE}/api/v2/pages/deploy/{SLUG}",
    headers={**HEADERS, "Content-Type": "application/json"},
    json={"html": html, "title": "NGU Parkering"},
    verify=False,
)
r.raise_for_status()
print("Deploy:", r.json())

# Verify
r = requests.get(f"{BASE}/api/v2/pages/deploy/{SLUG}", headers=HEADERS, verify=False)
p = r.json()
print("HTML bytes now:", len(p.get("html") or ""))
print("Live URL:", f"{BASE}/web/{SLUG}")
