// issues/053 (2026-10-16): no access log existed for the v5 backends, so slow or
// large API responses in production were invisible. deploy/docker/render.sh now
// makes Caddy log every request as JSON on stdout (logger
// "http.log.access.<tenant>", shipped to Loki by promtail) without headers, with
// the client IP truncated and secrets in the query string redacted, and caps the
// proxy container's Docker log size. Guards the generated Caddyfile and compose.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RENDER = path.join(__dirname, "..", "deploy", "docker", "render.sh");

function render() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  fs.copyFileSync(RENDER, path.join(dir, "render.sh"));
  fs.writeFileSync(path.join(dir, "tenants.conf"), "demo 1340 /var/www/demo/uploads\nbuida 1342 /var/www/buida/uploads\n");
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(path.join(dir, "state", "demo"), "green\n");
  execFileSync("bash", [path.join(dir, "render.sh")], { stdio: "pipe" });
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  const out = { caddyfile: read("caddy/Caddyfile"), compose: read("docker-compose.yml") };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

describe("render.sh access logs (issue 053)", () => {
  let caddyfile, compose;
  beforeAll(() => ({ caddyfile, compose } = render()));

  test("each live tenant site logs its requests under its own name", () => {
    expect(caddyfile).toMatch(/:1340 \{\n\timport access_log demo\n\treverse_proxy 127\.0\.0\.1:21340/);
    // No state file yet: no site, so no logger either.
    expect(caddyfile).not.toMatch(/access_log buida/);
  });

  test("the access log is JSON on stdout", () => {
    const snippet = caddyfile.match(/\(access_log\) \{[\s\S]*?\n\}\n/)[0];
    expect(snippet).toMatch(/log \{args\[0\]\}/);
    expect(snippet).toMatch(/output stdout/);
    expect(snippet).toMatch(/wrap json/);
  });

  test("headers, proxy address and query secrets stay out of the log", () => {
    const snippet = caddyfile.match(/\(access_log\) \{[\s\S]*?\n\}\n/)[0];
    expect(snippet).toMatch(/request>headers delete/);
    expect(snippet).toMatch(/resp_headers delete/);
    expect(snippet).toMatch(/request>client_ip ip_mask 16 32/);
    for (const key of ["access_token", "id_token", "token", "code", "confirmation", "password", "jwt"]) {
      expect(snippet).toMatch(new RegExp(`replace ${key} REDACTED`));
    }
  });

  test("text people type and usernames in the query string are redacted", () => {
    const snippet = caddyfile.match(/\(access_log\) \{[\s\S]*?\n\}\n/)[0];
    for (const key of ["_q", "name", "[code_contains]", "_where[users_permissions_user.username]"]) {
      expect(snippet).toContain(`replace ${key} REDACTED\n`);
    }
  });

  test("the proxy container's Docker log is capped", () => {
    const proxy = compose.match(/\n {2}proxy:\n[\s\S]*?(?=\n {2}[a-z]|\nvolumes:)/)[0];
    expect(proxy).toMatch(/logging:\n\s+driver: json-file\n\s+options: \{ max-size: 10m, max-file: "3" \}/);
  });
});
