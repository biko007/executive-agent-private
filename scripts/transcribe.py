#!/usr/bin/env python3
"""Local Whisper transcription via faster-whisper.
Usage: python3 transcribe.py <audio_file> [language]
Prints transcript to stdout. Exits with code 0 on success, 1 on failure.
"""
import sys
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: transcribe.py <audio_file> [language]"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "de"

    try:
        from faster_whisper import WhisperModel
        model = WhisperModel("small", device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, language=language, beam_size=5)
        text = " ".join(seg.text.strip() for seg in segments)
        print(json.dumps({"text": text, "language": info.language, "probability": round(info.language_probability, 2)}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
