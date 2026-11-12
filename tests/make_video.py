import subprocess, imageio_ffmpeg, os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ff = imageio_ffmpeg.get_ffmpeg_exe()
wav = os.path.join(root, "tests", "speech_en.wav")
out = os.path.join(root, "tests", "test_video.mp4")
cmd = [ff, "-y", "-f", "lavfi", "-i", "color=c=0x1b0a38:s=960x540:d=10",
       "-i", wav, "-shortest", "-c:v", "libx264", "-preset", "veryfast",
       "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
       "-movflags", "+faststart", out]
print(" ".join(cmd))
subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
print(out, os.path.getsize(out))
