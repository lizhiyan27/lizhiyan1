import os, sys, time, wave, winsound
import numpy as np
import soundcard as sc

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
wav = os.path.join(root, "tests", "speech_en.wav")
out = os.path.join(root, "tests", "loopback_en.wav")
speaker = sc.default_speaker()
loop = sc.get_microphone(id=str(speaker.name), include_loopback=True)
print("speaker", speaker.name, "loop", loop.name)
with loop.recorder(samplerate=48000, channels=2, blocksize=4800) as rec:
    winsound.PlaySound(wav, winsound.SND_FILENAME | winsound.SND_ASYNC)
    data = rec.record(numframes=48000 * 11)
print("recorded", data.shape)
mono = data.mean(axis=1)
pcm = (np.clip(mono, -1, 1) * 32767).astype(np.int16)
with wave.open(out, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(48000)
    w.writeframes(pcm.tobytes())
print(out, os.path.getsize(out))
