# Security Policy

## Supported versions

Metis is currently in alpha. Security fixes are applied to the latest published
pre-release; older alpha builds are not supported.

## Reporting a vulnerability

Do not disclose a vulnerability in a public issue. Use GitHub's private vulnerability
reporting for this repository:

<https://github.com/TZUKWAN/metis-in-social-science/security/advisories/new>

Include the affected version, reproduction steps, impact, and a minimal proof of
concept. Remove API keys, private documents, user databases, and personally
identifying information before attaching evidence.

The maintainers will acknowledge a complete report, reproduce it, assess severity,
and coordinate remediation and disclosure. Please allow time for a fix before public
discussion.

## Installer verification

Alpha installers are not Authenticode-signed. Download them only from this repository's
GitHub Releases page and compare the SHA-256 value with the checksum published in the
same release before running the installer.
