# Warm dictation worker, run inside SpeechBird's own virtualenv so the team
# borrows the model the user already downloaded and tuned rather than
# shipping a second copy of Whisper.
#
# Protocol: one JSON object per line each way.
#   in   {"path": "C:/.../clip.webm"}
#   out  {"ready": true}          once, when the model is loaded
#        {"text": "..."} | {"error": "..."}   one per request
#
# The model load is the slow part (seconds), so the process stays alive between
# clips. Everything noisy goes to stderr; stdout carries only protocol.
import json
import os
import sys

SETTINGS = os.path.join(os.environ.get("APPDATA", ""), "Dictate", "settings.json")


def load_settings():
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    s = load_settings()
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            s.get("model", "base.en"),
            device="cpu",
            compute_type=s.get("compute_type", "int8"),
        )
    except Exception as e:
        say({"error": f"could not load Whisper: {e}"})
        return 1

    say({"ready": True, "model": s.get("model", "base.en")})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            segments, _ = model.transcribe(
                req["path"],
                language=s.get("language") or None,
                vad_filter=bool(s.get("vad_filter", True)),
            )
            say({"text": " ".join(seg.text.strip() for seg in segments).strip()})
        except Exception as e:
            say({"error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
