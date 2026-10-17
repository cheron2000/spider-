# Windows: Free local coding agents

This guide connects the Spider dashboard to local Ollama models through Aider. Model inference stays on this PC. The framework API and GitHub Issues coordinate work; each task runs in its own Git worktree.

## Hardware baseline

With 16 GB system RAM, start with one Ollama model and one worker. A second worker can operate in parallel in a separate worktree, but it may compete for GPU memory and model inference. Start two workers only after checking VRAM and observing memory usage. The GPU's VRAM, not just system RAM, determines comfortable model size.

Recommended first model: `qwen2.5-coder:7b`. If the GPU has 12 GB+ VRAM, benchmark a larger coding model before changing the default. Avoid loading multiple different models at once on a low-VRAM card.

## Install

1. Install current NVIDIA drivers and Ollama for Windows: https://ollama.com/download
2. In PowerShell:

   ```powershell
   ollama pull qwen2.5-coder:7b
   ollama run qwen2.5-coder:7b
   ```

   Exit the chat after confirming it responds. Ollama normally runs in the background on `http://127.0.0.1:11434`.

3. Install Node.js 20+ and Git for Windows. In the framework repo:

   ```powershell
   npm install
   Copy-Item .env.example .env
   # Edit .env: set GITHUB_TOKEN and GITHUB_REPOSITORY=owner/repo
   npm run dev
   ```

   Open http://localhost:5173. The API is http://localhost:4000.

4. Create a separate, clean clone of the project the agents should edit. Do not point the worker at a working directory containing secrets or uncommitted work:

   ```powershell
   git clone https://github.com/OWNER/PROJECT.git C:\agent-target
   cd C:\agent-target
   git status --short
   ```

   The target clone must have an `origin` remote and the configured base branch (default `main`).

5. Install Aider in an isolated Python environment. Use Python 3.10–3.12 if possible:

   ```powershell
   py -3 -m venv .venv-aider
   .\.venv-aider\Scripts\Activate.ps1
   python -m pip install --upgrade pip
   python -m pip install aider-chat requests
   ```

   Verify `aider --version` and `python -c "import requests; print(requests.__version__)"`.

## Start one worker

Open a second PowerShell window at the framework repository root. Configure paths for your machine:

```powershell
$env:FRAMEWORK_API = "http://127.0.0.1:4000"
$env:AGENT_ID = "local-coder-1"
$env:AGENT_REPO_PATH = "C:\agent-target"
$env:AGENT_WORKSPACE_ROOT = "C:\spider-agent-workspaces"
$env:AGENT_BASE_BRANCH = "main"
$env:OLLAMA_MODEL = "qwen2.5-coder:7b"
$env:AGENT_AUTO_APPROVE = "1"
python .\agents\local_coding_worker.py
```

**Security warning:** `AGENT_AUTO_APPROVE=1` enables Aider's automatic approval mode so unattended jobs can run. Model-generated code and tool actions are not inherently safe. Use a disposable clone with no secrets, do not run the worker as Administrator, and review every branch before running code or merging. The worker never pushes or merges automatically.

## Add a second worker

Use another PowerShell window, the same model and workspace root, but a unique agent ID:

```powershell
$env:FRAMEWORK_API = "http://127.0.0.1:4000"
$env:AGENT_ID = "local-coder-2"
$env:AGENT_REPO_PATH = "C:\agent-target"
$env:AGENT_WORKSPACE_ROOT = "C:\spider-agent-workspaces"
$env:AGENT_BASE_BRANCH = "main"
$env:OLLAMA_MODEL = "qwen2.5-coder:7b"
$env:AGENT_AUTO_APPROVE = "1"
python .\agents\local_coding_worker.py
```

Each task gets a separate Git worktree and branch, avoiding simultaneous edits to the same checkout. With limited VRAM, both agents may be active but model inference can slow down or queue. Start with one worker and add the second only after monitoring GPU memory.

## How tasks flow

1. The dashboard's CEO planner creates GitHub Issues.
2. Workers poll `GET /api/tasks`, claim eligible `todo` issues and register/heartbeat with the API.
3. A worker creates `agent/issue-N-...` in an isolated worktree from `origin/main`.
4. Aider asks Ollama to implement the issue. The worker runs `git diff --check` and reports the branch/worktree/log to the dashboard.
5. Human reviews the worktree and opens a PR manually. The worker does not push, commit, merge, install dependencies, or run project tests automatically.

## Important MVP limits

- Task and agent telemetry is in-memory in the API. Restarting the API loses active claims and live completion reports; GitHub issues remain the durable task source.
- The worker uses the framework's in-memory task API, so keep the API running while agents work.
- This is a local development prototype, not a hardened execution sandbox. Do not expose the API or Ollama endpoint to the public internet.
- For safe parallelism, assign distinct tasks and have a human integrate/review. Add durable leases, cancellation, test profiles, and isolated OS-level sandboxing before unattended use.
