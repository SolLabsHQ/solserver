# PR #42: v0 Production Launch & TestFlight

**Date:** 2026-02-03  
**Author:** Manus AI (TPM)  
**Status:** DRAFT

---

## 1. Summary

This PR represents the final, critical step to make the v0 release official: deploying the `solserver` backend to a production environment on Fly.io and submitting the `solmobile` iOS application to TestFlight for internal distribution. This PR does not introduce new features but instead focuses exclusively on the infrastructure, configuration, and process required to move the v0 codebase into a live, production-ready state.

## 2. Motivation

With all v0 feature PRs (through #41) successfully merged, the code is complete, but the product is not yet launched. This PR bridges the gap between a feature-complete `main` branch and a stable, usable product in the hands of its first users. It is the formal gate for declaring v0 "done" and officially beginning the v0.1 release cycle.

## 3. Scope

### In Scope

*   **`solserver` Production Deployment:**
    *   Finalize `fly.toml` configuration for the production environment.
    *   Provision a production-grade database on Fly.io.
    *   Set up production secrets and environment variables (`FLY_SECRETS`).
    *   Configure production logging, monitoring, and alerting.
    *   Execute the first production deployment and verify its health.
*   **`solmobile` TestFlight Submission:**
    *   Create the application entry in App Store Connect.
    *   Configure provisioning profiles and code signing for a release build.
    *   Create a new build archive and upload it to TestFlight.
    *   Set up an internal testing group and distribute the build.
*   **Documentation:**
    *   Create a `PRODUCTION_DEPLOYMENT.md` runbook in `infra-docs` detailing the step-by-step process for deploying and managing the production environment.

### Out of Scope

*   **New Features:** No new application features will be added.
*   **Code Changes:** No changes to the application logic in `solserver` or `solmobile` are planned, unless a critical, deployment-blocking bug is discovered.
*   **Public App Store Release:** This PR targets TestFlight for internal distribution only, not a public release on the App Store.

## 4. Technical Design

### Fly.io Production Environment

*   **App Name:** `solos-prod` (or similar, to be confirmed).
*   **Region:** A single region will be chosen for the initial deployment (e.g., `sjc` for San Jose).
*   **Scaling:** The initial deployment will use a single, non-scaled machine. A scaling strategy will be defined but not implemented until traffic requires it.
*   **Database:** A new, dedicated Postgres or SQLite volume will be provisioned for the production database, separate from any staging or development databases.
*   **Secrets:** All production secrets (API keys, database credentials, etc.) will be managed via `fly secrets set` and will not be checked into version control.

### TestFlight Build & Distribution

*   **Bundle ID:** A production bundle identifier will be used (e.g., `com.sollabs.solos`).
*   **Build Configuration:** A new "Release" build configuration will be used in Xcode, pointing to the production `solserver` endpoint.
*   **Versioning:** The build will be versioned as `1.0.0 (v0)`. 
*   **Testing Group:** An "Internal Testers" group will be created in App Store Connect, containing the core team members.

## 5. Implementation Plan & Checklist

### Phase 1: Backend Deployment (`solserver` on Fly.io)

- [ ] **Fly.io App:** Create the new production application on Fly.io (`fly apps create solos-prod`).
- [ ] **Database:** Provision the production database volume (`fly volumes create ...`).
- [ ] **Configuration:** Finalize and commit the `fly.toml` file for the production environment.
- [ ] **Secrets:** Set all required production secrets using `fly secrets set`.
- [ ] **Deployment:** Execute the first production deployment (`fly deploy`).
- [ ] **Health Check:** Verify the deployment is healthy by checking logs (`fly logs`) and hitting the health check endpoint.

### Phase 2: Frontend Deployment (`solmobile` on TestFlight)

- [ ] **App Store Connect:** Create the `SolOS` application in App Store Connect.
- [ ] **Build Configuration:** Create the "Release" scheme in Xcode, ensuring it points to the production backend URL.
- [ ] **Code Signing:** Configure the correct provisioning profiles and certificates for an App Store distribution build.
- [ ] **Archive:** Create a new build archive from the `main` branch.
- [ ] **Upload:** Upload the build archive to App Store Connect / TestFlight.
- [ ] **Internal Testing:** Add the core team to the "Internal Testers" group and release the build to them.

### Phase 3: Verification & Launch

- [ ] **Smoke Test:** All internal testers install the app via TestFlight and perform a coordinated smoke test of all v0 features.
- [ ] **Launch Confirmation:** Once the smoke test is passed and the build is deemed stable, formally declare v0 as launched.
- [ ] **Documentation:** Create and commit the `PRODUCTION_DEPLOYMENT.md` runbook to `infra-docs`.

## 6. Questions for the Team

- **Q1 (for Jam):** Please confirm the desired App Name for Fly.io (e.g., `solos-prod`) and the production Bundle ID for the iOS app (e.g., `com.sollabs.solos`).
- **Q2 (for Codex):** Are there any environment-specific configurations in the current codebase that need to be abstracted into environment variables before the production deployment?

---
