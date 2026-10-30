# Privacy policy

Applies to the ModuTeX 0.3.0 Windows desktop application. Last updated: 2026-10-30.

## Documents and local data

Editing, parsing, PDF preview and compilation run on the local computer. ModuTeX stores documents and generated outputs in the selected workspace or configured output locations. Preferences, recent-file records and compiler caches are stored locally. Recent-file records and compiler logs may contain filenames and local paths.

ModuTeX has no built-in document cloud-sync service, analytics service or automatic document/crash-report upload service. Its update and compiler-resource requests do not upload the document text, images or compiled PDF. A user-configured command or external tool can have additional access and network behavior.

## Network activity

| Activity                            | When it occurs                                                                                                       | Recipient and information                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update availability check           | Automatically after desktop startup initializes the application state.                                               | Requests the update manifest from this project's GitHub Releases endpoint. GitHub and its delivery providers receive ordinary HTTP request information, including the source IP address and client headers. Document contents are not included. |
| Update download                     | After the user chooses to download an offered update. Installation requires a separate user action.                  | Downloads release artifacts from GitHub and its delivery providers.                                                                                                                                                                             |
| Compiler resource download          | During a compilation requested by the user, when required TeX packages or fonts are absent from the local cache.     | Tectonic requests resources from its configured official bundle service. The service receives resource requests and ordinary network metadata.                                                                                                  |
| WebView2 installation and servicing | The online installer may obtain a missing WebView2 Runtime; the installed runtime may also be serviced by Microsoft. | Microsoft provides the runtime and governs its own processing under its privacy statement.                                                                                                                                                      |
| User-configured tools               | When the user runs an external compiler, trusted custom command or terminal command.                                 | Destinations and transmitted information depend on the selected tool and command. Review those tools' policies and configuration.                                                                                                               |

The desktop application currently has no in-app switch to disable the automatic update availability check. Dismissing an update notice does not disable the check on future launches. Operating-system network controls can block outbound connections; missing compiler resources and update checks then remain unavailable. Editing and previewing existing local content do not require those downloads.

The PDF preview ships its character maps, fonts and codecs locally and does not load them from a CDN. An installer containing offline WebView2 resources does not imply that all TeX packages are bundled or that the application never connects to the network.

## Third-party services

Review the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) and [Microsoft privacy statement](https://privacy.microsoft.com/privacystatement) for their services. TeX resource requests are handled by the bundle service and its hosting providers. ModuTeX does not control those providers' server logs or retention.

The optional developer MCP feature is excluded from the default desktop build. A build enabling it can expose explicitly enabled local automation to connected clients; those clients' access and any external processing depend on their permissions and configuration.

## User control and support

Choose where documents and outputs are saved, remove unneeded local recent-file records and caches, and review custom commands before running them. Deleting a recent-file entry removes that record rather than deleting the document. Removing local files does not remove a provider's network logs or copies previously shared with other services.

Information voluntarily posted to [GitHub issues](https://github.com/leo2783/ModuTeX/issues), including logs and attachments, is handled by GitHub and may be public. Remove private document contents, paths and credentials before posting. Privacy-policy corrections can be reported to [leo2783](https://github.com/leo2783) through the project repository.

[Code signing policy](../distribution/SIGNPATH_ELIGIBILITY.md) · [Installation](INSTALLATION.md) · [Compilation](COMPILATION.md)
