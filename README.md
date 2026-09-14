# Awaaz Gateway Sidekick Repository

This directory (`sidekick_server/`) contains **only** the Node.js Voice Gateway server and web caller page needed for Railway deployment.

## 🚀 How to deploy to Railway in 1 minute:

1. Create a new GitHub repo named `awaaz-gateway` (or similar).
2. Copy the files in this directory into that repository.
3. Push to GitHub:
   ```bash
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```
4. On **[Railway.app](https://railway.app)**:
   - Click **"+ New Project"** -> **"Deploy from GitHub repo"**.
   - Select `awaaz-gateway`.
   - Under **Variables**, add `ASSEMBLYAI_API_KEY` with your API key.
   - Under **Settings -> Networking**, click **Generate Domain**.
5. Done! Your webpage will be live at `https://your-domain.up.railway.app/caller.html`.
