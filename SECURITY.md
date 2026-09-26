# Security policy

## Reporting a vulnerability

Do **not** open a public issue for a suspected credential leak, authentication bypass, passcode bypass, upload validation bypass, or malicious APK distribution path.

Use GitHub's private vulnerability-reporting feature for this repository. If it is not enabled, contact the repository owner privately through the contact route documented on the repository profile. Include a minimal reproduction, affected endpoint or file, impact, and any mitigation you have already tested.

We will acknowledge a report within 7 days and coordinate a fix before public disclosure.

## Suspected secret exposure

Treat the following as production credentials and rotate them immediately if exposed:

- `UPLOAD_TOKENS`
- `APP_SECRET`
- `R2_S3_ACCESS_KEY_ID`
- `R2_S3_SECRET_ACCESS_KEY`

After rotation, invalidate any affected CI secrets and review recent uploads/releases. Never commit `.dev.vars*`, Wrangler output, or credential-bearing curl commands.
