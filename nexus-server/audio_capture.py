"""
Audio Capture Module - Captures audio from PulseAudio and provides WebRTC AudioStreamTrack
"""

import asyncio
import subprocess
import numpy as np
import threading
from typing import Optional, List
from aiortc import MediaStreamTrack
from av import AudioFrame
import fractions


class PulseAudioCapture:
    """
    Captures audio from PulseAudio's monitor source using parec
    This allows us to capture the audio output from Chromium.

    Audio is captured in a background thread and buffered so multiple
    tracks can read from the same source.
    """

    def __init__(self, source: str = "browser_audio.monitor", sample_rate: int = 48000, channels: int = 2):
        self.source = source
        self.sample_rate = sample_rate
        self.channels = channels
        self.process: Optional[subprocess.Popen] = None
        self._running = False
        self._lock = threading.Lock()
        self._current_frame: Optional[np.ndarray] = None
        self._frame_count = 0
        self._capture_thread: Optional[threading.Thread] = None
        self._samples_per_frame = 960  # 20ms at 48kHz

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

        # Start background capture thread
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._capture_thread.start()

        print(f"[AudioCapture] Started capturing from {self.source}")

    def _capture_loop(self):
        """Background thread that continuously captures audio frames"""
        bytes_needed = self._samples_per_frame * self.channels * 2
        log_interval = 500  # Log audio stats every 500 frames (~10 seconds)

        while self._running and self.process:
            try:
                data = self.process.stdout.read(bytes_needed)
                if len(data) < bytes_needed:
                    # Pad with silence if we don't have enough data
                    data = data + b'\x00' * (bytes_needed - len(data))

                # Convert to numpy array
                audio = np.frombuffer(data, dtype=np.int16)
                audio = audio.reshape(-1, self.channels)

                with self._lock:
                    self._current_frame = audio
                    self._frame_count += 1

                    # Log audio stats periodically
                    if self._frame_count % log_interval == 0:
                        max_amplitude = np.max(np.abs(audio))
                        rms = np.sqrt(np.mean(audio.astype(np.float32) ** 2))
                        if max_amplitude > 100:
                            print(f"[AudioCapture] Frame {self._frame_count}: Audio detected! RMS={rms:.1f}, Peak={max_amplitude}")
                        else:
                            print(f"[AudioCapture] Frame {self._frame_count}: Silence (RMS={rms:.1f}, Peak={max_amplitude})")

            except Exception as e:
                print(f"[AudioCapture] Capture error: {e}")
                break

    def stop(self):
        """Stop capturing audio"""
        self._running = False
        if self.process:
            self.process.terminate()
            self.process.wait()
            self.process = None
        if self._capture_thread:
            self._capture_thread.join(timeout=1.0)
            self._capture_thread = None
        print("[AudioCapture] Stopped")

    def get_current_frame(self) -> tuple[Optional[np.ndarray], int]:
        """
        Get the current audio frame and its sequence number.
        Multiple tracks can call this to get the same frame.

        Returns:
            (frame, frame_count) tuple
        """
        with self._lock:
            return self._current_frame, self._frame_count

    def read_frame(self, samples: int = 960) -> Optional[np.ndarray]:
        """
        Read a frame of audio samples (legacy method, kept for compatibility)

        Args:
            samples: Number of samples to read (960 = 20ms at 48kHz)

        Returns:
            numpy array of shape (samples, channels) with int16 values
        """
        frame, _ = self.get_current_frame()
        return frame

    @property
    def is_running(self) -> bool:
        return self._running


class SpotifyAudioTrack(MediaStreamTrack):
    """
    Custom AudioStreamTrack that reads from PulseAudio capture
    and streams it via WebRTC.

    Multiple instances can share the same PulseAudioCapture source.
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
        self._last_frame_count = -1

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

        # Get current audio frame from shared capture
        audio_data, frame_count = self.capture.get_current_frame()

        # If no new frame, wait a bit and try again
        if frame_count == self._last_frame_count or audio_data is None:
            await asyncio.sleep(0.005)  # 5ms
            audio_data, frame_count = self.capture.get_current_frame()

        self._last_frame_count = frame_count

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

    def clone(self) -> 'SpotifyAudioTrack':
        """Create a new track instance sharing the same capture source"""
        return SpotifyAudioTrack(self.capture)


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
