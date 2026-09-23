# Backlog

English | [简体中文](backlog.zh.md)

This document records user-requested plans that have not shipped and remain deferred. Starting implementation requires separate authorization.
Use code, the [README](../README.md), and active ADRs for current behavior. Keep entries to their goals and necessary prerequisites, and update them when plans change.

## Public npm installation

No public npm package has been published. The plan is distribution through the public npm registry, followed by installation with npm install and startup from the command line.
Windows, macOS, and Linux would share this approach without an additional desktop installer.
Version 1.0.0 currently runs from a source build; the [README](../README.md) provides those steps.

Before publication, decide licensing, package naming, and publishing permissions, and validate startup after installation from the public registry.
CI already covers isolated package installation and cross-platform execution. Public distribution needs separate validation.

The Web console, Cloudflare/Tailscale connections, asynchronous questions, and notifications have shipped. See the [README](../README.md) for usage.
