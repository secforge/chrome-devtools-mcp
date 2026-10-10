---
name: secret-handling
description: Uses Chrome DevTools MCP to fill passwords, API keys, tokens and other credentials into a page without the plaintext ever appearing in the conversation, and to reuse the same script across calls via sourcePath. Use when logging into a site, filling a password or 2FA field, automating an authenticated flow, or running the same JavaScript repeatedly.
---

## Core Concepts

### Why placeholders exist

Everything you pass to a tool is recorded in the conversation transcript. Typing a password directly into `fill`, `fill_form`, `type_text` or `evaluate_script` therefore writes that password into a durable log that anyone reading the transcript later can see.

Instead, name the credential and let the MCP server substitute it:

```json
{"uid": "5_3", "value": "{{secret:acme-login-7f3a}}"}
```

The server reads the file, splices the value in, and dispatches it to the browser. You never see the value, so it cannot leak through you.

> [!IMPORTANT]
> The rule is about **where the plaintext exists**, not about who types it. Staging a secret with `echo "hunter2" > .../secrets/x` puts the password in a tool call and defeats the entire mechanism. Always stage **by reference** — see below.

### Placeholder reference

The exact directories are named in the `value` / `text` / `function` parameter descriptions of the tools; read them rather than guessing a path.

| Placeholder             | Trailing newline | File after the call |
| :---------------------- | :--------------- | :------------------ |
| `{{secret:X}}`          | stripped         | **deleted**         |
| `{{secret:X:raw}}`      | kept             | **deleted**         |
| `{{secret:X:keep}}`     | stripped         | kept                |
| `{{secret:X:raw:keep}}` | kept             | kept                |

- Secrets are **consumed by default** so they do not linger on disk. Use `:keep` for a credential you need in several calls (e.g. a password plus a confirmation field in separate steps).
- Deletion happens only **after the call succeeds**, so a failed fill leaves the secret staged and you can retry without re-staging.

### Staging a secret by reference

Write the file from an existing source so the plaintext never passes through a tool argument:

```bash
pass show acme/login          > <secrets-dir>/acme-login-7f3a   # password manager
cp ~/.config/acme/token         <secrets-dir>/acme-token-9c21   # existing file
printf '%s' "$ACME_PASSWORD"  > <secrets-dir>/acme-login-7f3a   # environment variable
security find-generic-password -s acme -w > <secrets-dir>/acme-login-7f3a  # macOS keychain
```

Never `echo "<the actual password>"`. If the credential only exists in something the user typed into the chat, it has already been recorded and this mechanism cannot retroactively protect it — say so rather than pretending otherwise.

### Choose unique names

The secrets directory is shared by every MCP server running in parallel. Use a specific name (`acme-login-7f3a`), never a generic one (`pw`): another session can overwrite a generic name and make you fill the wrong credential into the wrong site, or delete it while you still need it.

---

## Workflow Patterns

### 1. Logging into a site

1. **Stage the credential** by reference (see above), choosing a unique name.
2. **Locate the fields**: `take_snapshot` to get the `uid`s of the username and password inputs.
3. **Fill both in one call** with `fill_form`, using the placeholder for the password:
   ```json
   {
     "elements": [
       {"uid": "5_3", "value": "user@example.com"},
       {"uid": "5_4", "value": "{{secret:acme-login-7f3a}}"}
     ]
   }
   ```
4. **Submit**: `click` the submit button, or pass `submitKey: "Enter"` to `type_text`.
5. **Verify**: `take_snapshot` or `list_network_requests` to confirm the login succeeded.

The secret file is gone after step 3 succeeded. If the login failed and you need to retry, the file is still there only if the _fill_ failed — a fill that succeeded against a wrong-password page still consumes it, so stage with `:keep` when you expect to retry.

### 2. Two-factor codes

A TOTP code is short-lived, so generate it straight into the secrets directory and let it be consumed:

```bash
oathtool --totp -b "$(pass show acme/totp-seed)" > <secrets-dir>/acme-otp-4b8e
```

Then `fill` with `{{secret:acme-otp-4b8e}}`. Consume-by-default is exactly right here: the code is useless after one use and should not remain on disk.

### 3. Reusing a script across calls

`evaluate_script` takes a `sourcePath`: a path to a JavaScript file on the MCP server's filesystem. Store the function once and point at it, instead of writing the code out in every call.

### 4. A script that needs a credential

Placeholders are resolved **after** `sourcePath` is read, so a stored script may carry a secret:

```js
// /path/to/login.js
async () => {
  document.querySelector('#user').value = 'user@example.com';
  document.querySelector('#pass').value = '{{secret:acme-login-7f3a}}';
  document.querySelector('form').submit();
};
```

Called with `sourcePath: "/path/to/login.js"`, the file is read and its secret substituted before the code reaches the browser.

---

## Troubleshooting

- **`No secret named "x" found at ...`**: The file was never staged, or a previous call consumed it. Re-stage it, and use `:keep` if several calls need it.
- **`Invalid secret name "..."`**: Names are plain file names. Paths, `..` and `/` are rejected so a reference cannot escape the directory.
- **`Unknown modifier ":..."`**: Only `:raw` and `:keep` exist, in any order.
- **The placeholder was typed into the page literally**: The parameter you used does not resolve placeholders. Only `fill`, `fill_form`, `type_text` and `evaluate_script`'s `function` do.
- **The wrong value was filled**: Another session probably reused the same generic name. Re-stage under a unique name.
- **You need to confirm what was filled**: Error messages and `type_text`'s confirmation deliberately echo the _placeholder_, never the substituted value. Verify the effect (a successful login, a snapshot) instead of trying to read the value back.

## Trust assumptions

This is a debugging mechanism. It keeps secrets out of the **transcript**; it does not sandbox them. Two consequences are deliberate:

- **A secret is not bound to a site.** `{{secret:acme-login}}` can be filled into, or set as a cookie on, any domain you name. `set_cookie` is the sharpest case: the browser then sends that cookie to that domain automatically. Name the target carefully.
- **A file read via `sourcePath` is as trusted as a credential.** Placeholders are resolved after the file is read, so any file containing `{{secret:NAME}}` will pull the real value into code that runs in the page. Only point `sourcePath` at files you wrote.

> [!WARNING]
> The substituted value is still sent to the site in the login request. After submitting credentials, avoid calling `get_network_request` on that request, or saving it with `requestFilePath`, unless you actually need it — the request body contains the plaintext and would put it back into the transcript.
