# Run ADT Bot on your own always-on server

One Docker Compose file starts everything your devices can hand off to a server:

| Service | What it does | Your Mac or phone then |
|---|---|---|
| `adt-bot` | The web app, sync between your devices, routines and triggers that run while your computers are off, and a relay that checks your token | opens the app from anywhere |
| `speech` | Voice mode's speech-to-text (Whisper) and natural voice (Kokoro) | only listens, notices speech and plays the reply |

The AI model itself stays where it is (Anthropic, OpenAI, …): nothing here costs API money.
Controlling your Mac (apps, WhatsApp, your browser) still needs the Mac app.

## What it needs

- A Linux machine with Docker that stays on: a free cloud VM (below), a mini PC or old laptop at home.
- About 3 GB of disk for the images and models, 2 GB of RAM (3 GB with the routines browser).
- Speech is the heavy part: about 1 s of CPU per second of speech on 4 laptop cores. On 2 small
  server cores, use the faster model or Groq's free speech-to-text (see "Faster speech" below).

## Oracle Cloud's free Arm VM

Oracle's Always Free tier is the only free cloud server big enough for this. Since June 2026 it
gives **2 OCPU and 12 GB of RAM** in total on Arm (Ampere A1), down from 4 and 24.

1. Sign up at <https://www.oracle.com/cloud/free/>. It needs a credit or debit card (prepaid and
   virtual cards are refused). Pick your **home region** carefully: free servers can only be made
   there, and it can't be changed. Mumbai and Hyderabad are closest to India, but each has a single
   data centre, so "out of capacity" there means waiting and retrying later.
2. **Create instance** → Image: Ubuntu 24.04 → Shape: **VM.Standard.A1.Flex**, 2 OCPU, 12 GB.
   Add your SSH key. If it says "Out of capacity", try again at another time of day.
3. Log in (`ssh ubuntu@<public IP>`) and install Docker and Tailscale:
   ```sh
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker ubuntu
   curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
   ```
   Log out and in again (for the docker group).
4. Get the code onto the server. The repository is private, so either clone it with a GitHub token
   (`git clone https://<token>@github.com/shoubhiksaha/adt-bot.git`), or copy it from your Mac:
   `git archive --format=tar.gz -o adt-bot.tar.gz HEAD && scp adt-bot.tar.gz ubuntu@<IP>:` then
   `mkdir adt-bot && tar -xzf adt-bot.tar.gz -C adt-bot` on the server.
5. Start it:
   ```sh
   cd adt-bot/deploy
   cp .env.example .env
   sed -i "s/^ADT_TOKEN=.*/ADT_TOKEN=$(openssl rand -hex 24)/" .env
   docker compose up -d --build
   grep ADT_TOKEN .env      # the server token, for the app
   ```
   The first start builds the app (a few minutes) and downloads the speech models (about 500 MB).
6. Give it a private HTTPS address: `sudo tailscale serve --bg 8787`. It prints an address like
   `https://adt-server.tailXXXX.ts.net`. Install Tailscale on your Mac and phone (free) and sign in
   with the same account: only your devices can reach the server. Oracle's firewall already keeps
   port 8787 closed to the internet; leave it closed.

Oracle may reclaim a free VM that looks idle for 7 days (CPU, network **and** memory all under 20%).
ADT Bot with speech uses about 2 GB, close to 20% of 12 GB. If Oracle warns you, upgrade the account to
Pay-As-You-Go: Always Free resources stay free, and idle PAYG instances aren't reclaimed.

## Connect the app

1. **Settings → Sync & server → Always-on server**: the Tailscale address and the server token. Turn on sync
   there too if you want your chats on every device.
2. **Settings → Voice → Speech on your server → Use my server for voice.** Voice mode now sends
   what you say to the server for speech-to-text and gets the reply's voice from it. "Use this device
   again" switches back.

## Faster speech

On 2 server cores, Whisper "base" takes a few seconds per sentence. Options, fastest first:

- **Groq's free speech-to-text** (no server work): Settings → Providers → add Groq with a free key
  from <https://console.groq.com>, then Settings → Voice → Speech recognition → Cloud Whisper →
  Groq, model `whisper-large-v3-turbo`. Free plan: about 2,000 requests and 8 hours of audio a day.
  Keep the server's Kokoro voice for replies.
- **A smaller model on the server**: in `deploy/.env` set
  `ADT_SPEECH_STT_MODEL=Systran/faster-whisper-tiny.en` (English only), then
  `docker compose up -d` and press "Use my server for voice" again.

## Everyday commands

```sh
docker compose logs -f adt-bot     # what the server is doing
docker compose pull && docker compose up -d --build   # update (after copying the new code)
docker compose down                # stop (data stays in the adt-data and speech-models volumes)
```

Other free and cheap places to run it (Google, Azure, AWS, Hugging Face, home hardware) and the free
speech services are compared, with sources, in [FREE-HOSTING.md](FREE-HOSTING.md) (October 2026).
