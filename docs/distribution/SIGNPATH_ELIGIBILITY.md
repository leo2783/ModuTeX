# Code signing policy

This policy covers the ModuTeX 0.3.0 Windows x64 Tauri application.

## Signing status

SignPath Foundation application preparation is in progress. Foundation acceptance, account configuration and a successfully signed release must be confirmed before a release is described as Foundation-signed. Unsigned candidates must be identified as unsigned in their release notes and filenames.

After acceptance and activation of Foundation signing, the acknowledgement for applicable signed releases will be:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

The [Foundation conditions](https://signpath.org/terms) govern eligibility and signing approval. This policy records project responsibilities and intended signing controls; Foundation review determines acceptance.

## Team responsibilities

| Role                | Current member                        | Responsibility                                                                                                |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Author / maintainer | [leo2783](https://github.com/leo2783) | Maintain the source, dependencies and build workflows.                                                        |
| Reviewer            | [leo2783](https://github.com/leo2783) | Review proposed changes, including contributions from other authors and changes to signing inputs.            |
| Signing approver    | [leo2783](https://github.com/leo2783) | Confirm the reviewed release commit, CI evidence and artifact identity before approving each signing request. |

All three roles are currently held by the same maintainer. Contributors' changes require maintainer review. Maintainers and signing approvers must use multi-factor authentication for GitHub and SignPath. Account enforcement and signing permissions must be verified during onboarding.

## Signed artifacts

Signing is limited to ModuTeX-owned binaries built from this repository on GitHub-hosted runners:

| Artifact configuration                                                                     | File inside the submitted ZIP      | Signed content                                                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------- |
| [modutex-exe-zip](../../.signpath/artifact-configurations/modutex-exe-zip.xml)             | `modutex-desktop-tauri.exe`        | The ModuTeX application executable.                                    |
| [modutex-installer-zip](../../.signpath/artifact-configurations/modutex-installer-zip.xml) | `ModuTeX_${version}_x64-setup.exe` | The outer NSIS installer containing the previously signed application. |

Both configurations enforce the `ModuTeX` product name and the release's product/file version. The required `version` parameter must match the release tag and application metadata.

Bundled third-party binaries, including Tectonic and Microsoft's WebView2 installer, retain their upstream identity. They are excluded from ModuTeX signing operations. Dependency licenses and notices are preserved; see [Licensing](../../LICENSING.md) and [Vendor resources](../vendor/VENDOR.md).

## Release and approval controls

The [release workflow](../../.github/workflows/tauri-release.yml) verifies that the tagged release commit belongs to `main`. Manual dispatch uses the `main` workflow source. The tag version must match the committed application versions.

The workflow runs the complete CI gate, retrieves the exact tested executable and verifies its source/artifact identity. Signing occurs in two stages: sign and verify the application executable, package it, then sign and verify the installer. Verification includes Authenticode publisher, timestamp, executable content identity and installer payload. Stable signed releases also require the separate Tauri updater signature.

Each Foundation signing request requires manual approval by the signing approver. Configure this requirement in SignPath for both stages. The approver checks the source commit, version, CI result and requested artifact before approving. The `release-signing` GitHub environment provides an additional approval boundary when its protection rules are configured.

The workflow creates a draft GitHub release. The maintainer reviews its signing status, checksums, provenance and updater artifacts before publishing it.

## Privacy

See the [ModuTeX privacy policy](../user/PRIVACY.md) for local document handling, automatic startup update checks, compiler resource downloads and third-party services. The startup update check is automatic; document contents are not part of that request.

## Application and setup

1. Publish this policy, its README links, accurate project descriptions and a usable download. Submit the [Foundation application](https://signpath.org/apply), identifying the intended 0.3.0 signing scope and any older public release supplied as project history.
2. Obtain Foundation approval and confirm the project's signing/approval roles. Review the disclosed startup network behavior and any applicable installation disclosure/consent requirements with the Foundation before declaring eligibility complete.
3. Link the SignPath project to the [GitHub trusted build system](https://docs.signpath.io/trusted-build-systems/github), configure its release policy and import both artifact configurations above.
4. Provide the following values to the GitHub release job through repository or `release-signing` environment settings:

   | Type     | Name                           | Value                                                                  |
   | -------- | ------------------------------ | ---------------------------------------------------------------------- |
   | Secret   | `SIGNPATH_API_TOKEN`           | Token for a SignPath CI identity permitted to submit signing requests. |
   | Variable | `SIGNPATH_ORGANIZATION_ID`     | The actual SignPath organization ID.                                   |
   | Variable | `SIGNPATH_PROJECT_SLUG`        | The approved project's slug.                                           |
   | Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | The release signing policy's slug.                                     |
   | Variable | `SIGNPATH_EXPECTED_PUBLISHER`  | The signing certificate's exact Subject.                               |

5. For a stable signed release, configure `TAURI_SIGNING_PRIVATE_KEY` and, if needed, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The private key must match the updater public key committed in the Tauri configuration. This key is separate from the SignPath-managed Authenticode certificate.
6. After the reviewed code is on `main` and its CI passes, use a matching release tag. Pushing a release tag already triggers the workflow; avoid starting a duplicate manual run. For an explicitly unsigned candidate, the manual workflow supports `force_unsigned_candidate`, subject to the same tag/version/source checks.

Contact the maintainer through [the project repository](https://github.com/leo2783/ModuTeX) for policy corrections. Review this policy when roles, network behavior, signing scope or release controls change.
