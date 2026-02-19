"""
Audio Capture Module - Captures audio from PulseAudio and provides WebRTC AudioStreamTrack
"""

import asyncio
import subprocess
import numpy as np
import threading
import queue
from typing import Optional
from aiortc import MediaStreamTrack
from av import AudioFrame
import fractions


class PulseAudioCapture:
    """
    Captures audio from PulseAudio's monitor source using parec.
    Uses a ring buffer to ensure smooth audio delivery to multiple tracks.
    """

    def __init__(self, source: str = "browser_audio.monitor", sample_rate: int = 48000, channels: int = 2):
        self.source = source
        self.sample_rate = sample_rate
        self.channels = channels
        self.process: Optional[subprocess.Popen] = None
        self._running = False
        self._capture_thread: Optional[threading.Thread] = None
        self._samples_per_frame = 960  # 20ms at 48kHz

        # Ring buffer for audio frames (hold ~1 second of audio)
        self._buffer_size = 50  # 50 frames = 1 second
        self._ring_buffer = []
        self._write_index = 0
        self._lock = threading.Lock()
        self._frame_count = 0

    def start(self):
        """Start capturing audio from PulseAudio"""
        if self._running:
            return

        # Initialize ring buffer with silence
        silence = np.zeros((self._samples_per_frame, self.channels), dtype=np.int16)
        self._ring_buffer = [silence.copy() for _ in range(self._buffer_size)]
        self._write_index = 0
        self._frame_count = 0

        # Use parec to capture from the monitor source
        cmd = [
            "parec",
            "--device", self.source,
            "--rate", str(self.sample_rate),
            "--channels", str(self.channels),
            "--format", "s16le",
            "--latency-msec", "10"  # Lower latency for better sync
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
        """Background thread that continuously captures audio frames into ring buffer"""
        bytes_per_frame = self._samples_per_frame * self.channels * 2
        log_interval = 500  # Log every ~10 seconds

        while self._running and self.process:
            try:
                # Read exactly one frame worth of data
                data = b''
                while len(data) < bytes_per_frame and self._running:
                    chunk = self.process.stdout.read(bytes_per_frame - len(data))
                    if not chunk:
                        break
                    data += chunk

                if len(data) < bytes_per_frame:
                    # Pad with silence if needed
                    data = data + b'\x00' * (bytes_per_frame - len(data))

                # Convert to numpy array
                audio = np.frombuffer(data, dtype=np.int16).copy()
                audio = audio.reshape(-1, self.channels)

                with self._lock:
                    # Write to ring buffer
                    self._ring_buffer[self._write_index] = audio
                    self._write_index = (self._write_index + 1) % self._buffer_size
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

    def get_frame_at_index(self, index: int) -> np.ndarray:
        """Get frame from ring buffer at specific index"""
        with self._lock:
            buffer_index = index % self._buffer_size
            return self._ring_buffer[buffer_index].copy()

    def get_current_frame_count(self) -> int:
        """Get the current frame count"""
        with self._lock:
            return self._frame_count

    @property
    def is_running(self) -> bool:
        return self._running


class SpotifyAudioTrack(MediaStreamTrack):
    """
    Custom AudioStreamTrack that reads from PulseAudio capture
    and streams it via WebRTC.

    Each track instance maintains its own read position to ensure
    continuous audio without drops or duplicates.
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
        self._next_frame_index = None  # Track which frame to read next
        self._frame_interval = 0.02  # 20ms per frame

    async def recv(self) -> AudioFrame:
        """
        Called by aiortc to get the next audio frame.
        Maintains proper timing and continuous frame delivery.
        """
        if self._start_time is None:
            self._start_time = asyncio.get_event_loop().time()
            # Start from current capture position
            self._next_frame_index = self.capture.get_current_frame_count()

        # Calculate when this frame should be delivered
        frame_number = self._timestamp // self._samples_per_frame
        target_time = self._start_time + (frame_number * self._frame_interval)
        current_time = asyncio.get_event_loop().time()

        # Wait if we're ahead of schedule
        if current_time < target_time:
            await asyncio.sleep(target_time - current_time)

        # Get the next frame from capture
        current_capture_frame = self.capture.get_current_frame_count()

        # If capture has fallen behind, skip ahead
        if self._next_frame_index < current_capture_frame - self.capture._buffer_size + 5:
            self._next_frame_index = current_capture_frame - 5  # Stay 5 frames behind current

        # If we're ahead of capture, wait for more data
        while self._next_frame_index >= current_capture_frame:
            await asyncio.sleep(0.005)
            current_capture_frame = self.capture.get_current_frame_count()

        # Get audio data
        audio_data = self.capture.get_frame_at_index(self._next_frame_index)
        self._next_frame_index += 1

        # Create AudioFrame
        frame = AudioFrame(format='s16', layout='stereo', samples=self._samples_per_frame)
        frame.sample_rate = self._sample_rate
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self._sample_rate)

        # Copy audio data to frame (interleaved stereo)
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
