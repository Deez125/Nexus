"""
Audio Capture Module - Captures audio from PulseAudio and provides WebRTC AudioStreamTrack
"""

import asyncio
import subprocess
import numpy as np
from typing import Optional
from aiortc import MediaStreamTrack
from av import AudioFrame
import fractions


class PulseAudioCapture:
    """
    Captures audio from PulseAudio's monitor source using parec
    This allows us to capture the audio output from Chromium
    """

    def __init__(self, source: str = "browser_audio.monitor", sample_rate: int = 48000, channels: int = 2):
        self.source = source
        self.sample_rate = sample_rate
        self.channels = channels
        self.process: Optional[subprocess.Popen] = None
        self._running = False

    def start(self):
        """Start capturing audio from PulseAudio"""
        if self._running:
            return

        # Use parec to capture from the monitor source
        # Output format: signed 16-bit little-endian PCM
        cmd = [
            "parec",
            "--device", self.source,
            "--rate", str(self.sample_rate),
            "--channels", str(self.channels),
            "--format", "s16le",
            "--latency-msec", "20"
        ]

        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0
        )
        self._running = True
        print(f"[AudioCapture] Started capturing from {self.source}")

    def stop(self):
        """Stop capturing audio"""
        if self.process:
            self.process.terminate()
            self.process.wait()
            self.process = None
        self._running = False
        print("[AudioCapture] Stopped")

    def read_frame(self, samples: int = 960) -> Optional[np.ndarray]:
        """
        Read a frame of audio samples

        Args:
            samples: Number of samples to read (960 = 20ms at 48kHz)

        Returns:
            numpy array of shape (samples, channels) with int16 values
        """
        if not self._running or not self.process:
            return None

        # Calculate bytes needed: samples * channels * 2 bytes per sample (16-bit)
        bytes_needed = samples * self.channels * 2

        try:
            data = self.process.stdout.read(bytes_needed)
            if len(data) < bytes_needed:
                # Pad with silence if we don't have enough data
                data = data + b'\x00' * (bytes_needed - len(data))

            # Convert to numpy array
            audio = np.frombuffer(data, dtype=np.int16)
            audio = audio.reshape(-1, self.channels)
            return audio

        except Exception as e:
            print(f"[AudioCapture] Read error: {e}")
            return None

    @property
    def is_running(self) -> bool:
        return self._running


class SpotifyAudioTrack(MediaStreamTrack):
    """
    Custom AudioStreamTrack that reads from PulseAudio capture
    and streams it via WebRTC
    """

    kind = "audio"

    def __init__(self, capture: PulseAudioCapture):
        super().__init__()
        self.capture = capture
        self._sample_rate = capture.sample_rate
        self._channels = capture.channels
        self._samples_per_frame = 960  # 20ms at 48kHz
        self._timestamp = 0
        self._start_time = None

    async def recv(self) -> AudioFrame:
        """
        Called by aiortc to get the next audio frame
        This is called roughly every 20ms
        """
        if self._start_time is None:
            self._start_time = asyncio.get_event_loop().time()

        # Calculate expected timestamp for pacing
        elapsed = asyncio.get_event_loop().time() - self._start_time
        expected_samples = int(elapsed * self._sample_rate)

        # Wait if we're ahead of schedule
        samples_ahead = self._timestamp - expected_samples
        if samples_ahead > self._samples_per_frame:
            await asyncio.sleep(samples_ahead / self._sample_rate)

        # Read audio from capture
        audio_data = self.capture.read_frame(self._samples_per_frame)

        if audio_data is None:
            # Generate silence if no data
            audio_data = np.zeros((self._samples_per_frame, self._channels), dtype=np.int16)

        # Create AudioFrame
        frame = AudioFrame(format='s16', layout='stereo', samples=self._samples_per_frame)
        frame.sample_rate = self._sample_rate
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self._sample_rate)

        # Copy audio data to frame
        # aiortc expects interleaved audio data
        frame.planes[0].update(audio_data.tobytes())

        # Increment timestamp
        self._timestamp += self._samples_per_frame

        return frame


class SilentAudioTrack(MediaStreamTrack):
    """
    A silent audio track for testing purposes
    """

    kind = "audio"

    def __init__(self, sample_rate: int = 48000, channels: int = 2):
        super().__init__()
        self._sample_rate = sample_rate
        self._channels = channels
        self._samples_per_frame = 960  # 20ms at 48kHz
        self._timestamp = 0
        self._start_time = None

    async def recv(self) -> AudioFrame:
        """Generate silent audio frames"""
        if self._start_time is None:
            self._start_time = asyncio.get_event_loop().time()

        # Calculate expected timestamp for pacing
        elapsed = asyncio.get_event_loop().time() - self._start_time
        expected_samples = int(elapsed * self._sample_rate)

        # Wait if we're ahead of schedule (pacing)
        samples_ahead = self._timestamp - expected_samples
        if samples_ahead > self._samples_per_frame:
            await asyncio.sleep(samples_ahead / self._sample_rate)

        # Generate silence
        silence = np.zeros((self._samples_per_frame, self._channels), dtype=np.int16)

        # Create AudioFrame
        frame = AudioFrame(format='s16', layout='stereo', samples=self._samples_per_frame)
        frame.sample_rate = self._sample_rate
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self._sample_rate)

        # Copy silence to frame
        frame.planes[0].update(silence.tobytes())

        # Increment timestamp
        self._timestamp += self._samples_per_frame

        return frame
