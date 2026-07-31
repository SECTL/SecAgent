#!/usr/bin/env python3
"""Small stdin/stdout bridge for sherpa-onnx streaming recognition.

Audio arrives as base64 encoded little-endian float32 PCM JSON messages.
Results are emitted as JSON lines so Electron can forward them to the UI.
"""

import argparse
import array
import base64
import json
import sys

import sherpa_onnx


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokens", required=True)
    parser.add_argument("--encoder", required=True)
    parser.add_argument("--decoder", required=True)
    parser.add_argument("--joiner", required=True)
    args = parser.parse_args()

    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=args.tokens,
        encoder=args.encoder,
        decoder=args.decoder,
        joiner=args.joiner,
        num_threads=2,
        sample_rate=16000,
        feature_dim=80,
        decoding_method="greedy_search",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4,
        rule2_min_trailing_silence=1.2,
        rule3_min_utterance_length=20,
    )
    stream = recognizer.create_stream()
    last_text = ""
    emit({"type": "ready"})

    for line in sys.stdin.buffer:
        try:
            message = json.loads(line)
            kind = message.get("type")
            if kind == "audio":
                samples = array.array("f")
                samples.frombytes(base64.b64decode(message["pcm"]))
                if sys.byteorder != "little":
                    samples.byteswap()
                stream.accept_waveform(16000, samples.tolist())
                while recognizer.is_ready(stream):
                    recognizer.decode_stream(stream)
                text = recognizer.get_result(stream) or ""
                if text != last_text:
                    last_text = text
                    emit({"type": "partial", "text": text})
                if recognizer.is_endpoint(stream):
                    emit({"type": "final", "text": text})
                    recognizer.reset(stream)
                    last_text = ""
            elif kind == "stop":
                stream.input_finished()
                while recognizer.is_ready(stream):
                    recognizer.decode_stream(stream)
                text = recognizer.get_result(stream) or ""
                emit({"type": "final", "text": text})
                break
        except Exception as error:
            emit({"type": "error", "message": str(error)})
            break


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        sys.exit(1)
