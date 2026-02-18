import { useState, useRef, useEffect, useCallback } from "react";
import { IoSettings, IoRefresh, IoCall, IoChevronDown } from "react-icons/io5";
import { FaCopy, FaPaste, FaMicrophoneSlash } from "react-icons/fa";
import { HiPhone, HiDesktopComputer, HiReply, HiTrash, HiUserCircle, HiPencil, HiVolumeUp, HiBan, HiChatAlt2, HiDotsHorizontal, HiPlus } from "react-icons/hi";
import { BsEmojiSmile, BsCameraVideoFill, BsCameraVideoOffFill, BsPinAngleFill } from "react-icons/bs";
import { IoMdSend } from "react-icons/io";
import { ImPhoneHangUp } from "react-icons/im";
import { GoScreenFull, GoScreenNormal } from "react-icons/go";
import { TiMicrophone } from "react-icons/ti";
import { LuScreenShare, LuScreenShareOff } from "react-icons/lu";
import { TbLayoutSidebarRightExpandFilled, TbLayoutSidebarLeftExpandFilled } from "react-icons/tb";
import { BsSpotify, BsPlayFill, BsPauseFill, BsSkipStartFill, BsSkipEndFill, BsShuffle, BsRepeat, BsRepeat1, BsMusicNoteList, BsSearch, BsPersonFill, BsChevronLeft } from "react-icons/bs";

// ─── WebRTC Configuration ─────────────────────────────────────────────────────
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Free TURN servers from Open Relay Project
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
  iceCandidatePoolSize: 10,
  iceTransportPolicy: "all",
};

// ─── SDP Modifier for better audio quality ────────────────────────────────────
function modifySdpForAudioQuality(sdp: string): string {
  // Increase Opus bitrate to 128kbps for better quality
  // Find the Opus codec line and add parameters
  let modifiedSdp = sdp;

  // Add stereo and high bitrate for Opus
  modifiedSdp = modifiedSdp.replace(
    /a=fmtp:111 /g,
    "a=fmtp:111 maxaveragebitrate=128000;stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=0;"
  );

  // If the fmtp line doesn't exist for Opus, we might need to add it
  if (!modifiedSdp.includes("a=fmtp:111")) {
    modifiedSdp = modifiedSdp.replace(
      /a=rtpmap:111 opus\/48000\/2/g,
      "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;maxaveragebitrate=128000;useinbandfec=1"
    );
  }

  return modifiedSdp;
}

// ─── WebSocket Hook ───────────────────────────────────────────────────────────
// Always connect to production backend
const WS_URL = "wss://nexus-api.pulpfliction.com/ws";

interface Message {
  id: number;
  from: string;
  time: string;
  text: string;
  client_id?: string;
}

interface User {
  client_id: string;
  username: string;
  in_call: boolean;
  has_audio: boolean;
  has_video: boolean;
  has_screen: boolean;
}

// Get account ID from URL path (e.g., /2 for Mad_Max2)
function getAccountIdFromUrl(): number {
  const path = window.location.pathname;
  const match = path.match(/^\/(\d+)$/);
  if (match) {
    const id = parseInt(match[1], 10);
    if (id === 1 || id === 2) return id;
  }
  return 1; // Default to account 1
}

// Generate client ID that includes the account ID for true separation
function getClientId(accountId: number): string {
  const storageKey = `nexus_client_id_${accountId}`;
  let clientId = sessionStorage.getItem(storageKey);
  if (!clientId) {
    clientId = `acc${accountId}_` + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    sessionStorage.setItem(storageKey, clientId);
  }
  return clientId;
}

// Get account at module level so CLIENT_ID is consistent
const CURRENT_ACCOUNT_ID = getAccountIdFromUrl();
const CLIENT_ID = getClientId(CURRENT_ACCOUNT_ID);

// WebRTC signal callback type
type WebRTCSignalCallback = (data: { type: string; from: string; offer?: RTCSessionDescriptionInit; answer?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => void;

function useNexusSocket(username: string, onWebRTCSignal?: WebRTCSignalCallback) {
  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usernameRef = useRef(username);
  const isConnectingRef = useRef(false);
  const webrtcCallbackRef = useRef(onWebRTCSignal);

  // Keep refs up to date
  usernameRef.current = username;
  webrtcCallbackRef.current = onWebRTCSignal;

  // Send username update when it changes (for account switching)
  const updateUsername = useCallback((newUsername: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "set_username", username: newUsername }));
    }
  }, []);

  // Update username on server when it changes
  useEffect(() => {
    if (connected) {
      updateUsername(username);
    }
  }, [username, connected, updateUsername]);

  const handleMessage = useCallback((data: any) => {
    switch (data.type) {
      case "connected":
        console.log("[Nexus] Connection confirmed:", data.client_id);
        // Initialize users list with existing users from server
        if (data.users && Array.isArray(data.users)) {
          console.log("[Nexus] Received existing users:", data.users.length);
          setUsers(data.users.map((u: any) => ({
            client_id: u.client_id,
            username: u.username,
            in_call: u.in_call || false,
            has_audio: u.has_audio || false,
            has_video: u.has_video || false,
            has_screen: u.has_screen || false,
          })));
        }
        break;

      case "user_joined":
        console.log("[Nexus] User joined:", data.username, "client_id:", data.client_id);
        setUsers(prev => {
          // Don't add if already exists
          if (prev.some(u => u.client_id === data.client_id)) {
            console.log("[Nexus] User already in list, skipping add");
            return prev;
          }
          console.log("[Nexus] Adding new user to list. Current count:", prev.length);
          return [...prev, { client_id: data.client_id, username: data.username, in_call: false, has_audio: false, has_video: false, has_screen: false }];
        });
        break;

      case "user_left":
        console.log("[Nexus] User left:", data.username);
        setUsers(prev => prev.filter(u => u.client_id !== data.client_id));
        break;

      case "username_changed":
        setUsers(prev => prev.map(u => u.client_id === data.client_id ? { ...u, username: data.new_username } : u));
        break;

      case "chat":
        const newMsg: Message = {
          id: Date.now() + Math.random(),
          from: data.username,
          time: new Date(data.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          text: data.content,
          client_id: data.client_id,
        };
        setMessages(prev => [...prev, newMsg]);
        break;

      case "call_user_joined":
        console.log("[Nexus] User joined call:", data.username, "client_id:", data.client_id);
        setUsers(prev => {
          // Check if user already exists in the list
          const existingUser = prev.find(u => u.client_id === data.client_id);
          if (existingUser) {
            // Update existing user's call state
            return prev.map(u => u.client_id === data.client_id ? { ...u, in_call: true } : u);
          } else {
            // Add new user to the list if they weren't there
            console.log("[Nexus] Adding previously unknown user to list:", data.username);
            return [...prev, {
              client_id: data.client_id,
              username: data.username,
              in_call: true,
              has_audio: false,
              has_video: false,
              has_screen: false,
            }];
          }
        });
        break;

      case "call_user_left":
        console.log("[Nexus] User left call:", data.username);
        setUsers(prev => prev.map(u => u.client_id === data.client_id ? { ...u, in_call: false, has_audio: false, has_video: false, has_screen: false } : u));
        break;

      case "media_state_changed":
        setUsers(prev => prev.map(u => u.client_id === data.client_id ? { ...u, has_audio: data.audio, has_video: data.video, has_screen: data.screen } : u));
        break;

      case "offer":
      case "answer":
      case "ice_candidate":
        console.log("[Nexus] WebRTC signal:", data.type, "from:", data.from);
        if (webrtcCallbackRef.current) {
          webrtcCallbackRef.current(data);
        }
        break;

      default:
        console.log("[Nexus] Unknown message type:", data.type);
    }
  }, []);

  useEffect(() => {
    // Don't connect if this is the OAuth callback popup
    if (window.location.pathname === "/callback") {
      return;
    }

    // Prevent double connection in React StrictMode
    if (isConnectingRef.current || wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    isConnectingRef.current = true;

    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
        return;
      }

      console.log("[Nexus] Connecting to server...");
      const ws = new WebSocket(`${WS_URL}/${CLIENT_ID}`);

      ws.onopen = () => {
        console.log("[Nexus] Connected to server");
        setConnected(true);
        // Set username after connecting using the ref for current value
        ws.send(JSON.stringify({ type: "set_username", username: usernameRef.current }));
      };

      ws.onclose = () => {
        console.log("[Nexus] Disconnected from server");
        setConnected(false);
        wsRef.current = null;
        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log("[Nexus] Attempting to reconnect...");
          connect();
        }, 3000);
      };

      ws.onerror = (error) => {
        console.error("[Nexus] WebSocket error:", error);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (err) {
          console.error("[Nexus] Failed to parse message:", err);
        }
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      isConnectingRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [handleMessage]);

  const sendMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "chat", content }));
    }
  }, []);

  const joinCall = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call_join" }));
    }
  }, []);

  const leaveCall = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call_leave" }));
    }
  }, []);

  const updateMediaState = useCallback((audio: boolean, video: boolean, screen: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "media_state", audio, video, screen }));
    }
  }, []);

  const sendWebRTCSignal = useCallback((type: "offer" | "answer" | "ice_candidate", target: string, payload: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, target, [type === "ice_candidate" ? "candidate" : type]: payload }));
    }
  }, []);

  return {
    connected,
    clientId: CLIENT_ID,
    users,
    messages,
    sendMessage,
    joinCall,
    leaveCall,
    updateMediaState,
    sendWebRTCSignal,
  };
}

// ─── Audio Devices Hook ───────────────────────────────────────────────────────
interface AudioDevice {
  deviceId: string;
  label: string;
  kind: "audioinput" | "audiooutput";
}

function useAudioDevices() {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedInputId, setSelectedInputId] = useState<string>("");
  const [selectedOutputId, setSelectedOutputId] = useState<string>("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMonitoring, setIsMonitoring] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const monitorStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Enumerate devices
  const refreshDevices = useCallback(async () => {
    try {
      // Need to request permission first to get device labels
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();

      const inputs: AudioDevice[] = devices
        .filter(d => d.kind === "audioinput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
          kind: "audioinput" as const,
        }));

      const outputs: AudioDevice[] = devices
        .filter(d => d.kind === "audiooutput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Speaker ${i + 1}`,
          kind: "audiooutput" as const,
        }));

      setInputDevices(inputs);
      setOutputDevices(outputs);

      // Set default if not selected
      if (!selectedInputId && inputs.length > 0) {
        setSelectedInputId(inputs[0].deviceId);
      }
      if (!selectedOutputId && outputs.length > 0) {
        setSelectedOutputId(outputs[0].deviceId);
      }
    } catch (err) {
      console.error("[AudioDevices] Failed to enumerate devices:", err);
    }
  }, [selectedInputId, selectedOutputId]);

  // Start monitoring audio level
  const startMonitoring = useCallback(async () => {
    if (isMonitoring) return;

    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedInputId ? { deviceId: { exact: selectedInputId } } : true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      monitorStreamRef.current = stream;

      // Create audio context and analyser
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      setIsMonitoring(true);

      // Start level monitoring loop
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevel = () => {
        if (!analyserRef.current) return;

        analyserRef.current.getByteFrequencyData(dataArray);

        // Calculate RMS level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const level = Math.min(100, (rms / 128) * 100);

        setAudioLevel(level);
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };

      updateLevel();
    } catch (err) {
      console.error("[AudioDevices] Failed to start monitoring:", err);
    }
  }, [isMonitoring, selectedInputId]);

  // Stop monitoring
  const stopMonitoring = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (monitorStreamRef.current) {
      monitorStreamRef.current.getTracks().forEach(t => t.stop());
      monitorStreamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    setIsMonitoring(false);
    setAudioLevel(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMonitoring();
    };
  }, [stopMonitoring]);

  // Re-monitor when input device changes
  useEffect(() => {
    if (isMonitoring) {
      stopMonitoring();
      startMonitoring();
    }
  }, [selectedInputId]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    inputDevices,
    outputDevices,
    selectedInputId,
    selectedOutputId,
    setSelectedInputId,
    setSelectedOutputId,
    audioLevel,
    isMonitoring,
    startMonitoring,
    stopMonitoring,
    refreshDevices,
  };
}

// ─── WebRTC Hook ──────────────────────────────────────────────────────────────
interface UseWebRTCOptions {
  onRemoteStream?: (stream: MediaStream) => void;
  onLocalVideoStream?: (stream: MediaStream | null) => void;
  onRemoteVideoStream?: (stream: MediaStream | null) => void;
  sendSignal: (type: "offer" | "answer" | "ice_candidate", target: string, payload: any) => void;
  selectedInputDeviceId?: string;
  selectedOutputDeviceId?: string;
}

function useWebRTC({ onRemoteStream, onLocalVideoStream, onRemoteVideoStream, sendSignal, selectedInputDeviceId, selectedOutputDeviceId }: UseWebRTCOptions) {
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [connectionState, setConnectionState] = useState<string>("new");
  const targetPeerRef = useRef<string | null>(null);
  const selectedDeviceRef = useRef(selectedInputDeviceId);
  const selectedOutputRef = useRef(selectedOutputDeviceId);

  // Keep device refs updated
  selectedDeviceRef.current = selectedInputDeviceId;
  selectedOutputRef.current = selectedOutputDeviceId;

  // Update output device when selection changes
  useEffect(() => {
    if (remoteAudioRef.current && selectedOutputDeviceId) {
      const audioElement = remoteAudioRef.current as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
      if (audioElement.setSinkId) {
        audioElement.setSinkId(selectedOutputDeviceId)
          .then(() => console.log("[WebRTC] Output device set to:", selectedOutputDeviceId))
          .catch(e => console.error("[WebRTC] Failed to set output device:", e));
      }
    }
  }, [selectedOutputDeviceId]);

  // Create or get audio element for remote playback
  useEffect(() => {
    if (!remoteAudioRef.current) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.volume = 1.0;
      // Keep it in DOM but invisible - some browsers need this
      audio.style.position = "absolute";
      audio.style.width = "1px";
      audio.style.height = "1px";
      audio.style.opacity = "0";
      audio.style.pointerEvents = "none";
      document.body.appendChild(audio);
      remoteAudioRef.current = audio;
      console.log("[WebRTC] Created remote audio element");
    }
    return () => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.remove();
        remoteAudioRef.current = null;
      }
    };
  }, []);

  // Initialize peer connection
  const createPeerConnection = useCallback((targetId: string) => {
    console.log("[WebRTC] Creating peer connection for target:", targetId);
    targetPeerRef.current = targetId;

    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate && targetPeerRef.current) {
        console.log("[WebRTC] Sending ICE candidate");
        sendSignal("ice_candidate", targetPeerRef.current, event.candidate.toJSON());
      }
    };

    pc.ontrack = (event) => {
      console.log("[WebRTC] Received remote track:", event.track.kind, "streams:", event.streams.length);

      if (event.track.kind === "audio") {
        const remoteStream = event.streams[0] || new MediaStream([event.track]);
        console.log("[WebRTC] Setting up remote audio stream, tracks:", remoteStream.getAudioTracks().length);

        // Set jitterBufferTarget on the receiver to add buffering (prevents skipping)
        // This is the key fix for choppy audio - adds 150ms of buffer
        const receiver = event.receiver;
        if (receiver && "jitterBufferTarget" in receiver) {
          (receiver as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = 150;
          console.log("[WebRTC] Set jitterBufferTarget to 150ms");
        }

        if (remoteAudioRef.current) {
          // Stop any existing playback first
          remoteAudioRef.current.pause();
          remoteAudioRef.current.srcObject = null;

          // Set new stream
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.volume = 1.0;

          // Try to play, handle autoplay restrictions
          const playPromise = remoteAudioRef.current.play();
          if (playPromise !== undefined) {
            playPromise
              .then(() => console.log("[WebRTC] Remote audio playing successfully"))
              .catch(e => {
                console.log("[WebRTC] Audio autoplay blocked, will play on user interaction:", e);
                // Add a one-time click handler to start audio
                const startAudio = () => {
                  remoteAudioRef.current?.play();
                  document.removeEventListener("click", startAudio);
                };
                document.addEventListener("click", startAudio);
              });
          }

          onRemoteStream?.(remoteStream);
        }
      } else if (event.track.kind === "video") {
        // Handle video track
        const remoteVideoStream = event.streams[0] || new MediaStream([event.track]);
        console.log("[WebRTC] Setting up remote video stream, tracks:", remoteVideoStream.getVideoTracks().length);
        onRemoteVideoStream?.(remoteVideoStream);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("[WebRTC] Connection state:", pc.connectionState);
      setConnectionState(pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] ICE connection state:", pc.iceConnectionState);
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [sendSignal, onRemoteStream]);

  // Start a call (initiator)
  const startCall = useCallback(async (targetId: string) => {
    console.log("[WebRTC] Starting call to:", targetId);

    try {
      // Get microphone access with selected device
      // IMPORTANT: Disable audio processing to prevent choppy/skipping audio
      // These can cause "ducking" and audio dropouts
      const audioConstraints: MediaTrackConstraints = {
        ...(selectedDeviceRef.current ? { deviceId: { exact: selectedDeviceRef.current } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      localStreamRef.current = stream;
      console.log("[WebRTC] Got local audio stream with device:", selectedDeviceRef.current || "default");

      const pc = createPeerConnection(targetId);

      // Add local tracks to connection
      stream.getTracks().forEach(track => {
        console.log("[WebRTC] Adding local track:", track.kind);
        pc.addTrack(track, stream);
      });

      // Create and send offer with modified SDP for better audio
      const offer = await pc.createOffer();
      const modifiedOffer = {
        type: offer.type,
        sdp: modifySdpForAudioQuality(offer.sdp || ""),
      };
      await pc.setLocalDescription(modifiedOffer as RTCSessionDescriptionInit);
      console.log("[WebRTC] Created and set local offer with enhanced audio");

      sendSignal("offer", targetId, modifiedOffer);
    } catch (err) {
      console.error("[WebRTC] Error starting call:", err);
    }
  }, [createPeerConnection, sendSignal]);

  // Handle incoming offer (supports both initial offers and renegotiation)
  const handleOffer = useCallback(async (fromId: string, offer: RTCSessionDescriptionInit) => {
    console.log("[WebRTC] Handling offer from:", fromId);

    try {
      let pc = peerConnectionRef.current;

      // Check if this is a renegotiation (we already have a connection with this peer)
      const isRenegotiation = pc && targetPeerRef.current === fromId;

      if (isRenegotiation) {
        console.log("[WebRTC] This is a renegotiation offer, reusing existing peer connection");
      } else {
        // This is a new connection - need to get audio and create peer connection
        console.log("[WebRTC] This is a new offer, creating peer connection");

        // Get microphone access with selected device
        // IMPORTANT: Disable audio processing to prevent choppy/skipping audio
        const audioConstraints: MediaTrackConstraints = {
          ...(selectedDeviceRef.current ? { deviceId: { exact: selectedDeviceRef.current } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
        localStreamRef.current = stream;
        console.log("[WebRTC] Got local audio stream with device:", selectedDeviceRef.current || "default");

        pc = createPeerConnection(fromId);

        // Add local tracks
        stream.getTracks().forEach(track => {
          console.log("[WebRTC] Adding local track:", track.kind);
          pc!.addTrack(track, stream);
        });
      }

      // Set remote description (offer)
      await pc!.setRemoteDescription(new RTCSessionDescription(offer));
      console.log("[WebRTC] Set remote description (offer)");

      // Process any pending ICE candidates
      for (const candidate of pendingCandidatesRef.current) {
        await pc!.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidatesRef.current = [];

      // Create and send answer with modified SDP for better audio
      const answer = await pc!.createAnswer();
      const modifiedAnswer = {
        type: answer.type,
        sdp: modifySdpForAudioQuality(answer.sdp || ""),
      };
      await pc!.setLocalDescription(modifiedAnswer as RTCSessionDescriptionInit);
      console.log("[WebRTC] Created and set local answer with enhanced audio");

      sendSignal("answer", fromId, modifiedAnswer);
    } catch (err) {
      console.error("[WebRTC] Error handling offer:", err);
    }
  }, [createPeerConnection, sendSignal]);

  // Handle incoming answer
  const handleAnswer = useCallback(async (fromId: string, answer: RTCSessionDescriptionInit) => {
    console.log("[WebRTC] Handling answer from:", fromId);

    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error("[WebRTC] No peer connection for answer");
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log("[WebRTC] Set remote description (answer)");

      // Process any pending ICE candidates
      for (const candidate of pendingCandidatesRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidatesRef.current = [];
    } catch (err) {
      console.error("[WebRTC] Error handling answer:", err);
    }
  }, []);

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback(async (fromId: string, candidate: RTCIceCandidateInit) => {
    console.log("[WebRTC] Handling ICE candidate from:", fromId);

    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription) {
      // Queue candidate if we don't have remote description yet
      console.log("[WebRTC] Queueing ICE candidate (no remote description yet)");
      pendingCandidatesRef.current.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log("[WebRTC] Added ICE candidate");
    } catch (err) {
      console.error("[WebRTC] Error adding ICE candidate:", err);
    }
  }, []);

  // Handle WebRTC signals from server
  const handleSignal = useCallback((data: { type: string; from: string; offer?: RTCSessionDescriptionInit; answer?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
    switch (data.type) {
      case "offer":
        if (data.offer) handleOffer(data.from, data.offer);
        break;
      case "answer":
        if (data.answer) handleAnswer(data.from, data.answer);
        break;
      case "ice_candidate":
        if (data.candidate) handleIceCandidate(data.from, data.candidate);
        break;
    }
  }, [handleOffer, handleAnswer, handleIceCandidate]);

  // Toggle microphone
  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsAudioEnabled(audioTracks[0]?.enabled ?? false);
    }
  }, []);

  // Toggle video on/off
  const toggleVideo = useCallback(async () => {
    const pc = peerConnectionRef.current;
    const targetId = targetPeerRef.current;

    if (isVideoEnabled) {
      // Turn off video - stop and remove video track
      console.log("[WebRTC] Turning off video");
      if (localVideoStreamRef.current) {
        localVideoStreamRef.current.getTracks().forEach(track => track.stop());
        localVideoStreamRef.current = null;
      }

      // Remove video sender from peer connection if it exists
      if (pc) {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track?.kind === "video");
        if (videoSender) {
          pc.removeTrack(videoSender);
        }

        // Renegotiate to inform the other peer
        if (targetId) {
          try {
            const offer = await pc.createOffer();
            const modifiedOffer = {
              type: offer.type,
              sdp: modifySdpForAudioQuality(offer.sdp || ""),
            };
            await pc.setLocalDescription(modifiedOffer as RTCSessionDescriptionInit);
            sendSignal("offer", targetId, modifiedOffer);
            console.log("[WebRTC] Sent renegotiation offer (video off)");
          } catch (err) {
            console.error("[WebRTC] Renegotiation failed:", err);
          }
        }
      }

      setIsVideoEnabled(false);
      onLocalVideoStream?.(null);
    } else {
      // Turn on video - get camera and add track
      console.log("[WebRTC] Turning on video");
      try {
        // Check if we're on a secure context (HTTPS or localhost)
        // Browsers block getUserMedia on insecure origins (HTTP over LAN)
        if (!window.isSecureContext) {
          console.warn("[WebRTC] Not a secure context - camera may be blocked. Consider using HTTPS or localhost.");
          console.warn("[WebRTC] Current origin:", window.location.origin);
        }

        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
        });
        console.log("[WebRTC] Got video stream:", videoStream.getVideoTracks().length, "video tracks");
        localVideoStreamRef.current = videoStream;

        // Add video track to peer connection if it exists
        if (pc) {
          const videoTrack = videoStream.getVideoTracks()[0];
          if (videoTrack) {
            pc.addTrack(videoTrack, videoStream);
            console.log("[WebRTC] Added video track to peer connection");
          }

          // Renegotiate to send the new video track
          if (targetId) {
            try {
              console.log("[WebRTC] Creating renegotiation offer for video...");
              const offer = await pc.createOffer();
              const modifiedOffer = {
                type: offer.type,
                sdp: modifySdpForAudioQuality(offer.sdp || ""),
              };
              await pc.setLocalDescription(modifiedOffer as RTCSessionDescriptionInit);
              sendSignal("offer", targetId, modifiedOffer);
              console.log("[WebRTC] Sent renegotiation offer (video on)");
            } catch (err) {
              console.error("[WebRTC] Renegotiation failed:", err);
            }
          } else {
            console.log("[WebRTC] No target peer for renegotiation - local video only");
          }
        } else {
          console.log("[WebRTC] No peer connection - local video preview only");
        }

        setIsVideoEnabled(true);
        onLocalVideoStream?.(videoStream);
      } catch (err: any) {
        console.error("[WebRTC] Failed to get video:", err);
        console.error("[WebRTC] Error name:", err?.name);
        console.error("[WebRTC] Error message:", err?.message);
        // Common errors:
        // - NotAllowedError: User denied permission OR insecure context
        // - NotFoundError: No camera found
        // - NotReadableError: Camera in use by another app
        if (err?.name === "NotAllowedError") {
          alert("Camera access denied. If you're accessing over LAN (not localhost), browsers require HTTPS for camera access.");
        }
      }
    }
  }, [isVideoEnabled, onLocalVideoStream, sendSignal]);

  // End call and cleanup
  const endCall = useCallback(() => {
    console.log("[WebRTC] Ending call");

    // Stop local audio stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    // Stop local video stream
    if (localVideoStreamRef.current) {
      localVideoStreamRef.current.getTracks().forEach(track => track.stop());
      localVideoStreamRef.current = null;
    }

    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    // Clear remote audio
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    // Notify about video stream cleanup
    onLocalVideoStream?.(null);
    onRemoteVideoStream?.(null);

    targetPeerRef.current = null;
    pendingCandidatesRef.current = [];
    setConnectionState("new");
    setIsAudioEnabled(true);
    setIsVideoEnabled(false);
  }, [onLocalVideoStream, onRemoteVideoStream]);

  return {
    startCall,
    endCall,
    handleSignal,
    toggleMute,
    toggleVideo,
    isAudioEnabled,
    isVideoEnabled,
    connectionState,
  };
}

// ─── Theme ───────────────────────────────────────────────────────────────────
const T = {
  bg0: "#08080c",
  bg1: "#0e0e14",
  bg2: "#15151e",
  bg3: "#1c1c28",
  bg4: "#252534",
  border: "rgba(255,255,255,0.05)",
  text: "#e2e2ec",
  textSoft: "#8e8ea6",
  textMuted: "#4e4e64",
  accent: "#7c6aef",
  accentSoft: "rgba(124,106,239,0.1)",
  green: "#34d399",
  red: "#ef4444",
  orange: "#fb923c",
  blue: "#60a5fa",
  pink: "#f472b6",
  yellow: "#fbbf24",
  font: "'Outfit', sans-serif",
};

// ─── Test Accounts ───────────────────────────────────────────────────────────
const TEST_ACCOUNTS = [
  { id: 1, username: "Mad_Max", avatar: "linear-gradient(135deg, #f472b6, #fb923c)", initial: "M", nameColor: T.pink },
  { id: 2, username: "Mad_Max2", avatar: "linear-gradient(135deg, #60a5fa, #34d399)", initial: "M", nameColor: T.blue },
];

// Helper to get avatar color by username
const getAvatarByUsername = (username: string): string => {
  const account = TEST_ACCOUNTS.find(a => a.username === username);
  return account?.avatar || T.accent;
};

const getNameColorByUsername = (username: string): string => {
  const account = TEST_ACCOUNTS.find(a => a.username === username);
  return account?.nameColor || T.accent;
};

// Friends list is dynamic based on current account
const getFriendsForAccount = (accountId: number) => {
  const otherAccount = TEST_ACCOUNTS.find(a => a.id !== accountId)!;
  return [
    { id: otherAccount.id, name: otherAccount.username, status: "online", activity: null, color: otherAccount.avatar, unread: 0 },
  ];
};

// Empty conversations - all chat will be live
const CONVERSATIONS: Record<number, { messages: { id: number; from: string; time: string; text: string }[] }> = {};

const statusColor = (s: string) =>
  s === "online" ? T.green : s === "idle" ? T.orange : s === "dnd" ? T.red : T.textMuted;

const statusLabel = (s: string) =>
  s === "online" ? "Online" : s === "idle" ? "Idle" : s === "dnd" ? "Do Not Disturb" : "Offline";

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  // Use the module-level account ID (determined from URL at load time)
  const currentAccountId = CURRENT_ACCOUNT_ID;
  const currentAccount = TEST_ACCOUNTS.find(a => a.id === currentAccountId)!;
  const myUsername = currentAccount.username;
  const friends = getFriendsForAccount(currentAccountId);

  // Set active friend to the other account
  const otherAccountId = currentAccountId === 1 ? 2 : 1;
  const [activeFriend, setActiveFriend] = useState<number>(otherAccountId);
  const [inCall, setInCall] = useState(false);
  const [myMuted, setMyMuted] = useState(false);
  const [myCamera, setMyCamera] = useState(false);
  const [myScreen, setMyScreen] = useState(false);
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [message, setMessage] = useState("");
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [friendsTab, setFriendsTab] = useState("all");
  const [contextMenu, setContextMenu] = useState<{ show: boolean; x: number; y: number; type: string; data?: any }>({ show: false, x: 0, y: 0, type: "" });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const callAreaRef = useRef<HTMLDivElement>(null);

  // WebRTC signal handler ref (will be set after useWebRTC is called)
  const webrtcSignalHandlerRef = useRef<((data: any) => void) | null>(null);

  // Audio devices management
  const {
    inputDevices,
    outputDevices,
    selectedInputId,
    selectedOutputId,
    setSelectedInputId,
    setSelectedOutputId,
    audioLevel,
    startMonitoring,
    stopMonitoring,
    refreshDevices,
  } = useAudioDevices();

  // WebSocket connection with WebRTC signal callback
  const {
    connected,
    clientId,
    users,
    messages: liveMessages,
    sendMessage: wsSendMessage,
    joinCall: wsJoinCall,
    leaveCall: wsLeaveCall,
    updateMediaState,
    sendWebRTCSignal,
  } = useNexusSocket(myUsername, (data) => {
    // Forward WebRTC signals to the handler
    webrtcSignalHandlerRef.current?.(data);
  });

  // WebRTC connection with selected devices
  const {
    startCall: webrtcStartCall,
    endCall: webrtcEndCall,
    handleSignal: webrtcHandleSignal,
    toggleMute: webrtcToggleMute,
    toggleVideo: webrtcToggleVideo,
    connectionState,
  } = useWebRTC({
    sendSignal: sendWebRTCSignal,
    selectedInputDeviceId: selectedInputId,
    selectedOutputDeviceId: selectedOutputId,
    onLocalVideoStream: (stream) => {
      setLocalVideoStream(stream);
      setMyCamera(!!stream);
    },
    onRemoteVideoStream: (stream) => {
      setRemoteVideoStream(stream);
    },
  });

  // Connect the WebRTC signal handler
  webrtcSignalHandlerRef.current = webrtcHandleSignal;

  // Debug: log clientId and connection state
  useEffect(() => {
    if (clientId) console.log("[Nexus] My client ID:", clientId);
  }, [clientId]);

  useEffect(() => {
    console.log("[WebRTC] Connection state changed:", connectionState);
  }, [connectionState]);

  // Close context menu on click anywhere
  useEffect(() => {
    const handleClick = () => setContextMenu({ show: false, x: 0, y: 0, type: "" });
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, type: string, data?: any) => {
    e.preventDefault();
    setContextMenu({ show: true, x: e.clientX, y: e.clientY, type, data });
  };

  const friend = friends.find((f) => f.id === activeFriend);
  const convo = CONVERSATIONS[activeFriend as keyof typeof CONVERSATIONS];

  // Find if friend is in the call (based on server state)
  const friendInCall = users.find(u => u.username === friend?.name && u.in_call);
  const friendHasVideo = friendInCall?.has_video || false;
  const friendHasScreen = friendInCall?.has_screen || false;

  // Find if Spotify bot is in the call
  const spotifyBotInCall = users.find(u => u.username === "Spotify" && u.in_call);

  // Count total participants in call for grid layout (me + friend + spotify bot + waiting placeholder)
  const participantCount = 1 + (friendInCall ? 1 : 1) + (spotifyBotInCall ? 1 : 0); // Always count at least 2 (me + friend/waiting)

  // Calculate tile size based on participant count - tiles must ALWAYS be 16:9
  const getTileSize = (count: number) => {
    // Calculate tile dimensions to fit nicely while maintaining 16:9
    // For 2 tiles: side by side, larger
    // For 3-4 tiles: 2x2 grid arrangement, medium
    // For 5-6 tiles: 3x2 grid arrangement, smaller
    if (count <= 2) {
      return { width: "min(45vw, 640px)", height: "auto" };
    } else if (count <= 4) {
      return { width: "min(40vw, 480px)", height: "auto" };
    } else {
      return { width: "min(30vw, 380px)", height: "auto" };
    }
  };

  // Debug: log when users state changes
  useEffect(() => {
    console.log("[Nexus] Users state updated:", users.map(u => ({ username: u.username, client_id: u.client_id.slice(0, 12), in_call: u.in_call })));
    console.log("[Nexus] Looking for friend:", friend?.name, "Found in call:", !!friendInCall);
  }, [users, friend?.name, friendInCall]);

  // Check if there's an incoming call (friend is in call but we're not)
  const incomingCall = !inCall && friendInCall;

  // Scroll to bottom when messages change or friend changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeFriend, liveMessages]);

  // Get friend's client ID from users list
  const friendUser = users.find(u => u.username === friend?.name);

  const startCall = async () => {
    setInCall(true);
    setMyMuted(false); // Default mic on
    wsJoinCall();
    // Send initial media state with mic ON
    setTimeout(() => updateMediaState(true, false, false), 100);

    // If friend is already in call, check who should initiate (lower client ID initiates)
    // This prevents "glare" where both sides try to send offers
    if (friendUser && friendInCall) {
      const shouldInitiate = clientId < friendUser.client_id;
      console.log("[Call] Friend already in call. My ID:", clientId, "Friend ID:", friendUser.client_id, "Should initiate:", shouldInitiate);
      if (shouldInitiate) {
        await webrtcStartCall(friendUser.client_id);
      }
      // If we shouldn't initiate, we wait for the friend to send us an offer
    }
  };

  const endCall = () => {
    setInCall(false);
    setMyMuted(false);
    setMyCamera(false);
    setMyScreen(false);
    wsLeaveCall();
    webrtcEndCall(); // Clean up WebRTC connection
  };

  const toggleMyMute = () => {
    const newMuted = !myMuted;
    setMyMuted(newMuted);
    updateMediaState(!newMuted, myCamera, myScreen);
    webrtcToggleMute(); // Toggle actual microphone
  };
  const toggleMyCamera = async () => {
    await webrtcToggleVideo(); // This will update myCamera via callback
    // Update server state with the toggled value
    updateMediaState(!myMuted, !myCamera, myScreen);
  };
  const toggleMyScreen = () => {
    const newScreen = !myScreen;
    setMyScreen(newScreen);
    updateMediaState(!myMuted, myCamera, newScreen);
  };

  // Track previous friend call state to detect when they join
  const prevFriendInCallRef = useRef(false);

  // Effect to initiate WebRTC when friend joins call (and I'm already in it)
  useEffect(() => {
    const wasInCall = prevFriendInCallRef.current;
    const isNowInCall = !!friendInCall;

    // Friend just joined and I'm already in call - check who should initiate
    // Use deterministic rule: lower client ID initiates to prevent glare
    if (!wasInCall && isNowInCall && inCall && friendUser) {
      const shouldInitiate = clientId < friendUser.client_id;
      console.log("[Call] Friend joined call. My ID:", clientId, "Friend ID:", friendUser.client_id, "Should initiate:", shouldInitiate);
      if (shouldInitiate) {
        webrtcStartCall(friendUser.client_id);
      }
      // If we shouldn't initiate, we wait for the friend to send us an offer
    }

    prevFriendInCallRef.current = isNowInCall;
  }, [friendInCall, inCall, friendUser, clientId, webrtcStartCall]);

  // Handle sending chat messages
  const handleSendMessage = () => {
    if (message.trim()) {
      wsSendMessage(message.trim());
      setMessage("");
    }
  };

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await callAreaRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  // Listen for fullscreen changes (e.g., user presses Escape)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const filteredFriends = friends.filter((f) => {
    const matchesSearch = f.name.toLowerCase().includes(searchQuery.toLowerCase());
    if (friendsTab === "online") return matchesSearch && f.status !== "offline";
    return matchesSearch;
  });

  const onlineFriends = filteredFriends.filter((f) => f.status !== "offline");
  const offlineFriends = filteredFriends.filter((f) => f.status === "offline");

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { overflow: hidden; background: ${T.bg0}; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${T.textMuted}; border-radius: 4px; }
        input::placeholder { color: ${T.textMuted}; }
        input:focus { outline: none; }
      `}</style>

      <div style={s.app} onContextMenu={(e) => handleContextMenu(e, "general")}>
        {/* ─── Left: Friends ─── */}
        <div style={s.leftPanel}>
          <div style={{ padding: "14px 12px 6px", fontFamily: "'Courier New', monospace", fontSize: "24px", fontWeight: 700, letterSpacing: "4px", color: T.accent, textShadow: `0 0 15px ${T.accent}60` }}>
            {">"} NEXUS_
          </div>
          <div style={{ padding: "8px 12px 8px" }}>
            <input style={s.searchInput} placeholder="Search friends..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </div>

          <div style={s.tabs}>
            {["all", "online", "add"].map((tab) => (
              <button key={tab} style={{ ...s.tab, color: friendsTab === tab ? T.text : T.textMuted, background: friendsTab === tab ? T.bg3 : "transparent" }} onClick={() => setFriendsTab(tab)}>
                {tab === "all" ? "All" : tab === "online" ? "Online" : "+ Add"}
              </button>
            ))}
          </div>

          <div style={s.friendsList}>
            {friendsTab !== "add" && onlineFriends.length > 0 && (
              <>
                <div style={{ ...s.sectionLabel, color: "#2a9d6a" }}>ONLINE — {onlineFriends.length}</div>
                {onlineFriends.map((f) => (
                  <FriendItem key={f.id} friend={f} active={activeFriend === f.id} onClick={() => { setActiveFriend(f.id); }} onContextMenu={(e: React.MouseEvent) => handleContextMenu(e, "friend", f)} />
                ))}
              </>
            )}
            {friendsTab === "all" && offlineFriends.length > 0 && (
              <>
                <div style={{ ...s.sectionLabel, marginTop: 12 }}>OFFLINE — {offlineFriends.length}</div>
                {offlineFriends.map((f) => (
                  <FriendItem key={f.id} friend={f} active={activeFriend === f.id} onClick={() => { setActiveFriend(f.id); }} onContextMenu={(e: React.MouseEvent) => handleContextMenu(e, "friend", f)} />
                ))}
              </>
            )}
            {friendsTab === "add" && (
              <div style={{ padding: "40px 20px", textAlign: "center", color: T.textMuted, fontSize: 13 }}>Add friend functionality coming soon</div>
            )}
          </div>

          <div
            style={{ ...s.userCard, cursor: "pointer" }}
            onClick={() => {
              // Open the other account in a new tab
              const nextAccountId = currentAccountId === 1 ? 2 : 1;
              window.open(`/${nextAccountId}`, '_blank');
            }}
            title="Click to open other account in new tab"
          >
            <div style={{ ...s.userAvatarLg, background: currentAccount.avatar }}>
              {currentAccount.initial}
              <div style={{ ...s.dot, background: connected ? T.green : T.red, width: 12, height: 12, border: `2.5px solid ${T.bg0}` }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{myUsername}</div>
              <div style={{ fontSize: 11, color: connected ? T.green : T.textMuted }}>{connected ? "Connected" : "Connecting..."}</div>
            </div>
            <button style={s.iconBtn} onClick={(e) => e.stopPropagation()}><IoSettings size={16} /></button>
          </div>
        </div>

        {/* ─── Right: Chat / Call ─── */}
        <div style={s.rightPanel}>
          {friend ? (
            <>
              {/* Top bar */}
              <div style={s.topBar}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ ...s.avatar, width: 36, height: 36, background: friend.color, fontSize: 14 }}>
                    {friend.name[0]}
                    <div style={{ ...s.dot, background: statusColor(friend.status), width: 11, height: 11, border: `2.5px solid ${T.bg1}` }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{friend.name}</div>
                    <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{friend.activity || statusLabel(friend.status)}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {!inCall && (
                    <button
                      style={{ ...s.callBtn, background: T.green }}
                      onClick={() => startCall()}
                    >
                      <IoCall size={16} />
                      <span>Call</span>
                    </button>
                  )}
                  <button
                    style={{ ...s.iconBtn, color: T.text }}
                    onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
                    title={rightSidebarOpen ? "Close sidebar" : "Open sidebar"}
                  >
                    {rightSidebarOpen ? <TbLayoutSidebarLeftExpandFilled size={20} /> : <TbLayoutSidebarRightExpandFilled size={20} />}
                  </button>
                </div>
              </div>

              {/* Incoming call UI - shows when friend is calling but we haven't joined */}
              {!inCall && incomingCall && (
                <div style={s.callArea}>
                  <div style={s.callGrid}>
                    {/* Friend's tile - they're calling */}
                    <div style={s.callTile}>
                      <div style={s.voicePlaceholder}>
                        <div style={{ ...s.avatarXl, background: friend.color }}>{friend.name[0]}</div>
                        <div style={{ fontSize: 13, fontWeight: 500, marginTop: 8 }}>{friend.name}</div>
                      </div>
                      <div style={s.tileName}>{friend.name}</div>
                    </div>

                    {/* My tile - waiting to join */}
                    <div style={{ ...s.callTile, background: T.bg3, border: `2px dashed ${T.textMuted}` }}>
                      <div style={s.voicePlaceholder}>
                        <div style={{ ...s.avatarXl, background: currentAccount.avatar, opacity: 0.5 }}>{currentAccount.initial}</div>
                        <div style={{ fontSize: 13, fontWeight: 500, marginTop: 8, color: T.textMuted }}>You</div>
                      </div>
                    </div>
                  </div>

                  {/* Big Join Call button */}
                  <div style={{ display: "flex", justifyContent: "center", padding: "12px 16px" }}>
                    <button
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "14px 32px",
                        background: T.green,
                        border: "none",
                        borderRadius: 8,
                        color: "#fff",
                        fontSize: 15,
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: T.font,
                      }}
                      onClick={() => startCall()}
                    >
                      <IoCall size={20} />
                      <span>Join Call</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Call area */}
              {inCall && (
                <div ref={callAreaRef} style={{ ...s.callArea, ...(isFullscreen ? { position: "fixed", inset: 0, zIndex: 9999, height: "100vh" } : {}) }}>
                  <div style={{
                    ...s.callGrid,
                    ...(isFullscreen ? {
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "center",
                      alignItems: "center",
                      alignContent: "center",
                      flex: 1,
                      padding: "40px 60px",
                      gap: 16,
                      maxHeight: "calc(100vh - 120px)",
                      width: "100%",
                    } : {})
                  }}>
                    {/* My tile - camera or avatar */}
                    <div style={{
                      ...s.callTile,
                      ...(isFullscreen ? {
                        ...getTileSize(participantCount),
                        aspectRatio: "16/9",
                        flex: "none",
                      } : {}),
                      ...(!isFullscreen && myScreen ? { order: 2 } : {})
                    }}>
                      {myCamera && localVideoStream ? (
                        <VideoElement stream={localVideoStream} muted mirrored />
                      ) : (
                        <div style={s.voicePlaceholder}>
                          <div style={{ ...s.avatarXl, background: currentAccount.avatar }}>{currentAccount.initial}</div>
                          <div style={{ fontSize: 13, fontWeight: 500, marginTop: 8 }}>{myUsername}</div>
                        </div>
                      )}
                      <div style={s.tileName}>{myUsername}</div>
                    </div>

                    {/* Friend tile - only shows if friend is in the call */}
                    {friendInCall && (
                      <div style={{
                        ...s.callTile,
                        ...(isFullscreen ? {
                          ...getTileSize(participantCount),
                          aspectRatio: "16/9",
                          flex: "none",
                        } : {}),
                        ...(!isFullscreen && (myScreen || friendHasScreen) ? { order: 3 } : {})
                      }}>
                        {friendHasVideo && remoteVideoStream ? (
                          <VideoElement stream={remoteVideoStream} />
                        ) : (
                          <div style={s.voicePlaceholder}>
                            <div style={{ ...s.avatarXl, background: friend.color }}>{friend.name[0]}</div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginTop: 8 }}>{friend.name}</div>
                          </div>
                        )}
                        <div style={s.tileName}>{friend.name}</div>
                      </div>
                    )}

                    {/* Friend's screen share tile - separate from their avatar/camera */}
                    {friendInCall && friendHasScreen && (
                      <div style={{
                        ...s.callTile,
                        ...(isFullscreen ? {
                          ...getTileSize(participantCount),
                          aspectRatio: "16/9",
                          flex: "none",
                        } : { order: 1 })
                      }}>
                        <div style={s.screenSharePlaceholder}>
                          <HiDesktopComputer size={36} style={{ marginBottom: 8 }} />
                          <div style={{ fontSize: 13, fontWeight: 500, color: T.textSoft }}>{friend.name}'s Screen</div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>1440p · 60fps</div>
                        </div>
                        <div style={s.tileName}>{friend.name}'s Screen</div>
                      </div>
                    )}

                    {/* Spotify bot tile - shows when bot is in call */}
                    {spotifyBotInCall && (
                      <div style={{
                        ...s.callTile,
                        ...(isFullscreen ? {
                          ...getTileSize(participantCount),
                          aspectRatio: "16/9",
                          flex: "none",
                        } : {}),
                        order: 99
                      }}>
                        <div style={s.voicePlaceholder}>
                          <BsSpotify size={48} color="#1DB954" />
                          <div style={{ fontSize: 13, fontWeight: 500, marginTop: 8 }}>Spotify</div>
                        </div>
                        <div style={s.tileName}>Spotify</div>
                      </div>
                    )}

                    {/* Waiting for friend to join - shows when friend not in call */}
                    {!friendInCall && (
                      <div style={{
                        ...s.callTile,
                        ...(isFullscreen ? {
                          ...getTileSize(participantCount),
                          aspectRatio: "16/9",
                          flex: "none",
                        } : {}),
                        ...(!isFullscreen && myScreen ? { order: 3 } : {}),
                        background: T.bg3,
                        border: `2px dashed ${T.textMuted}`
                      }}>
                        <div style={s.voicePlaceholder}>
                          <div style={{ ...s.avatarXl, background: friend.color, opacity: 0.5 }}>{friend.name[0]}</div>
                          <div style={{ fontSize: 13, fontWeight: 500, marginTop: 8, color: T.textMuted }}>Calling {friend.name}...</div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Waiting for them to join</div>
                        </div>
                      </div>
                    )}

                    {/* Screen share tile - only shows when sharing */}
                    {myScreen && (
                      <div style={{
                        ...s.callTile,
                        ...(isFullscreen ? {
                          ...getTileSize(participantCount),
                          aspectRatio: "16/9",
                          flex: "none",
                        } : { order: 1 })
                      }}>
                        <div style={s.screenSharePlaceholder}>
                          <HiDesktopComputer size={36} style={{ marginBottom: 8 }} />
                          <div style={{ fontSize: 13, fontWeight: 500, color: T.textSoft }}>You are sharing your screen</div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>1440p · 60fps</div>
                        </div>
                        <div style={s.tileName}>Your Screen</div>
                      </div>
                    )}
                  </div>

                  <div style={{ ...s.callControlsWrapper, ...(isFullscreen ? { position: "absolute", bottom: 0, left: 0, right: 0, padding: "16px 24px" } : {}) }}>
                    <div style={s.callControls}>
                      <MicrophoneButton
                        isMuted={myMuted}
                        onToggleMute={toggleMyMute}
                        inputDevices={inputDevices}
                        outputDevices={outputDevices}
                        selectedInputId={selectedInputId}
                        selectedOutputId={selectedOutputId}
                        onSelectInput={setSelectedInputId}
                        onSelectOutput={setSelectedOutputId}
                        audioLevel={audioLevel}
                        onStartMonitoring={startMonitoring}
                        onStopMonitoring={stopMonitoring}
                        onRefreshDevices={refreshDevices}
                      />
                      <CallBtnWithDropdown
                        icon={myCamera ? <BsCameraVideoFill size={20} /> : <BsCameraVideoOffFill size={20} />}
                        onClick={toggleMyCamera}
                        active={myCamera}
                        tooltip={myCamera ? "Turn Off Camera" : "Turn On Camera"}
                        colorMode="green"
                        dropdownItems={[
                          { label: "Default Camera", onClick: () => {} },
                          { label: "External Webcam", onClick: () => {} },
                          { label: "Video Settings", onClick: () => {} },
                        ]}
                      />
                      <CallBtnWithDropdown
                        icon={myScreen ? <LuScreenShareOff size={20} /> : <LuScreenShare size={20} />}
                        onClick={toggleMyScreen}
                        active={myScreen}
                        tooltip={myScreen ? "Stop Sharing" : "Share Your Screen"}
                        colorMode="green"
                        dropdownItems={[
                          { label: "Entire Screen", onClick: () => {} },
                          { label: "Application Window", onClick: () => {} },
                          { label: "Browser Tab", onClick: () => {} },
                        ]}
                      />
                      <EndCallBtn onClick={endCall} />
                    </div>
                    <FullscreenBtn isFullscreen={isFullscreen} onClick={toggleFullscreen} />
                  </div>
                </div>
              )}

              {/* Messages */}
              <div style={s.messagesArea}>
                <div style={s.convoStart}>
                  <div style={s.convoStartAvatar}>
                    <div style={{ ...s.avatar, width: 72, height: 72, background: friend.color, fontSize: 28 }}>{friend.name[0]}</div>
                    <div style={{ ...s.dot, background: statusColor(friend.status), width: 16, height: 16, border: `3px solid ${T.bg1}`, bottom: 2, right: 2 }} />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, marginTop: 12 }}>{friend.name}</div>
                  <div style={{ fontSize: 13, color: T.textSoft, marginTop: 4 }}>This is the beginning of your direct message history with <span style={{ fontWeight: 600, color: T.text }}>{friend.name}</span></div>
                  <div style={s.convoStartDivider}>
                    <div style={s.convoStartLine} />
                    <span style={{ fontSize: 11, color: T.textMuted, padding: "0 12px", background: T.bg1 }}>Today</span>
                    <div style={s.convoStartLine} />
                  </div>
                </div>

                {/* Mock messages */}
                {convo && convo.messages.map((msg, idx) => (
                  <Msg
                    key={`mock-${msg.id}`}
                    msg={msg}
                    myUsername={myUsername}
                    onContextMenu={(e) => handleContextMenu(e, "message", msg)}
                    isFirst={idx === 0 || convo.messages[idx - 1].from !== msg.from}
                  />
                ))}
                {/* Live messages from server */}
                {liveMessages.map((msg, idx) => (
                  <Msg
                    key={`live-${msg.id}`}
                    msg={{ ...msg, from: msg.from === myUsername ? "me" : msg.from }}
                    myUsername={myUsername}
                    onContextMenu={(e) => handleContextMenu(e, "message", msg)}
                    isFirst={idx === 0 || liveMessages[idx - 1]?.from !== msg.from}
                  />
                ))}
                {!convo && liveMessages.length === 0 && (
                  <div style={{ padding: "20px 24px", color: T.textMuted, fontSize: 13 }}>No messages yet. Say hi!</div>
                )}

                {/* Incoming call notification */}
                {incomingCall && !inCall && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    margin: "8px 20px",
                    padding: "12px 16px",
                    background: "rgba(52, 211, 153, 0.1)",
                    border: `1px solid rgba(52, 211, 153, 0.3)`,
                    borderRadius: 8,
                  }}>
                    <div style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      background: "rgba(52, 211, 153, 0.2)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: T.green,
                    }}>
                      <IoCall size={18} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.green }}>{friend.name} started a call</div>
                      <div style={{ fontSize: 12, color: T.textSoft, marginTop: 2 }}>Click Join Call above to connect</div>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div style={s.inputArea}>
                <div style={s.inputRow}>
                  <InputIconBtn><HiPlus size={20} /></InputIconBtn>
                  <input style={s.msgInput} placeholder={`Message @${friend.name}`} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && message.trim()) handleSendMessage(); }} />
                  <div style={s.inputActions}>
                    <div style={{ position: "relative" }}>
                      <InputIconBtn onClick={() => setShowGifPicker(!showGifPicker)}>
                        <span style={{ fontSize: 11, fontWeight: 700 }}>GIF</span>
                      </InputIconBtn>
                      {showGifPicker && <GifPicker onClose={() => setShowGifPicker(false)} />}
                    </div>
                    {message.trim() && (
                      <button style={s.sendBtn} onClick={handleSendMessage}><IoMdSend size={16} /></button>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: T.textMuted }}>
              Select a friend to start chatting
            </div>
          )}
        </div>

        {/* Right Sidebar - Spotify */}
        {rightSidebarOpen && (
          <SpotifySidebar isConnected={spotifyConnected} onConnect={() => setSpotifyConnected(true)} onDisconnect={() => setSpotifyConnected(false)} />
        )}

        {/* Context Menu */}
        {contextMenu.show && (
          <ContextMenu x={contextMenu.x} y={contextMenu.y} type={contextMenu.type} data={contextMenu.data} onClose={() => setContextMenu({ show: false, x: 0, y: 0, type: "" })} />
        )}
      </div>
    </>
  );
}

// ─── Sub Components ──────────────────────────────────────────────────────────

function InputIconBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const [h, setH] = useState(false);
  return (
    <button
      style={{ ...s.inputIconBtn, background: h ? T.bg3 : "transparent", color: h ? T.text : T.textMuted }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SpotifyControlBtn({ children, onClick, size = 32, active = false }: { children: React.ReactNode; onClick?: () => void; size?: number; active?: boolean }) {
  const [h, setH] = useState(false);
  return (
    <button
      style={{
        width: size,
        height: size,
        background: "transparent",
        border: "none",
        color: active ? "#1DB954" : h ? T.text : T.textSoft,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        transition: "all 0.15s",
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Spotify API base URL - uses relative path which will be proxied in dev or direct in prod
// Always use production API
const SPOTIFY_API = "https://nexus-api.pulpfliction.com/api/spotify";

function SpotifySidebar({ isConnected, onConnect, onDisconnect: _onDisconnect }: { isConnected: boolean; onConnect: () => void; onDisconnect: () => void }) {
  const [activeTab, setActiveTab] = useState<"playing" | "playlists" | "search" | "artist" | "album">("playing");
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "context" | "track">("off");
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(50);
  const [hoverPlaylist, setHoverPlaylist] = useState<number | null>(null);
  const [currentTrack, setCurrentTrack] = useState<{ name: string; artist: string; artistId?: string; album: string; albumArt: string; duration: number; progress: number } | null>(null);
  const [playlists, setPlaylists] = useState<{ id: string; name: string; tracks: number; image: string | null; uri: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{
    tracks: { id: string; name: string; artist: string; artistId: string; album: string; albumArt: string; uri: string }[];
    albums: { id: string; name: string; artist: string; artistId: string; image: string; uri: string; releaseDate: string }[];
    artists: { id: string; name: string; image: string; followers: number }[];
  }>({ tracks: [], albums: [], artists: [] });
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<{ name: string; image: string | null } | null>(null);
  const [artistView, setArtistView] = useState<{ id: string; name: string; image: string; followers: number; albums: { id: string; name: string; image: string; uri: string; releaseDate: string; type: string }[] } | null>(null);
  const [albumView, setAlbumView] = useState<{ id: string; name: string; image: string; artist: string; artistId: string; uri: string; releaseDate: string; tracks: { id: string; name: string; uri: string; duration: number; trackNumber: number }[] } | null>(null);
  const [previousTab, setPreviousTab] = useState<"playing" | "playlists" | "search">("search");
  const [botInCall, setBotInCall] = useState(false);
  const [botLoading, setBotLoading] = useState(false);

  // Format time helper
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Fetch player state
  const fetchPlayerState = useCallback(async () => {
    try {
      const res = await fetch(`${SPOTIFY_API}/player`);
      if (res.ok) {
        const data = await res.json();
        if (data.item) {
          setCurrentTrack({
            name: data.item.name,
            artist: data.item.artists?.map((a: any) => a.name).join(", ") || "Unknown",
            artistId: data.item.artists?.[0]?.id,
            album: data.item.album?.name || "Unknown",
            albumArt: data.item.album?.images?.[0]?.url || "",
            duration: data.item.duration_ms || 0,
            progress: data.progress_ms || 0,
          });
          setIsPlaying(data.is_playing || false);
          setShuffle(data.shuffle_state || false);
          setRepeat(data.repeat_state || "off");
          if (data.item.duration_ms) {
            setProgress((data.progress_ms / data.item.duration_ms) * 100);
          }
          if (data.device?.volume_percent !== undefined) {
            setVolume(data.device.volume_percent);
          }
        }
      }
    } catch (e) {
      console.error("Failed to fetch player state:", e);
    }
  }, []);

  // Fetch playlists
  const fetchPlaylists = useCallback(async () => {
    try {
      const res = await fetch(`${SPOTIFY_API}/playlists`);
      if (res.ok) {
        const data = await res.json();
        setPlaylists(
          (data.items || []).map((p: any) => ({
            id: p.id,
            name: p.name,
            tracks: p.tracks?.total || 0,
            image: p.images?.[0]?.url || null,
            uri: p.uri,
          }))
        );
      }
    } catch (e) {
      console.error("Failed to fetch playlists:", e);
    }
  }, []);

  // Fetch user info
  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch(`${SPOTIFY_API}/me`);
      if (res.ok) {
        const data = await res.json();
        setUser({
          name: data.display_name || data.id,
          image: data.images?.[0]?.url || null,
        });
      }
    } catch (e) {
      console.error("Failed to fetch user:", e);
    }
  }, []);

  // Initialize when connected
  useEffect(() => {
    if (isConnected) {
      fetchUser();
      fetchPlaylists();
      fetchPlayerState();
      // Poll player state every 2 seconds
      const interval = setInterval(fetchPlayerState, 2000);
      return () => clearInterval(interval);
    }
  }, [isConnected, fetchUser, fetchPlaylists, fetchPlayerState]);

  // Playback controls
  const togglePlay = async () => {
    try {
      const endpoint = isPlaying ? "pause" : "play";
      await fetch(`${SPOTIFY_API}/player/${endpoint}`, { method: "PUT" });
      setIsPlaying(!isPlaying);
    } catch (e) {
      console.error("Failed to toggle play:", e);
    }
  };

  const skipNext = async () => {
    try {
      await fetch(`${SPOTIFY_API}/player/next`, { method: "POST" });
      setTimeout(fetchPlayerState, 300);
    } catch (e) {
      console.error("Failed to skip:", e);
    }
  };

  const skipPrevious = async () => {
    try {
      await fetch(`${SPOTIFY_API}/player/previous`, { method: "POST" });
      setTimeout(fetchPlayerState, 300);
    } catch (e) {
      console.error("Failed to go previous:", e);
    }
  };

  const toggleShuffle = async () => {
    try {
      await fetch(`${SPOTIFY_API}/player/shuffle?state=${!shuffle}`, { method: "PUT" });
      setShuffle(!shuffle);
    } catch (e) {
      console.error("Failed to toggle shuffle:", e);
    }
  };

  const cycleRepeat = async () => {
    const nextState = repeat === "off" ? "context" : repeat === "context" ? "track" : "off";
    try {
      await fetch(`${SPOTIFY_API}/player/repeat?state=${nextState}`, { method: "PUT" });
      setRepeat(nextState);
    } catch (e) {
      console.error("Failed to set repeat:", e);
    }
  };

  const seek = async (percent: number) => {
    if (!currentTrack) return;
    const positionMs = Math.floor((percent / 100) * currentTrack.duration);
    try {
      await fetch(`${SPOTIFY_API}/player/seek?position_ms=${positionMs}`, { method: "PUT" });
      setProgress(percent);
    } catch (e) {
      console.error("Failed to seek:", e);
    }
  };

  const setVolumeLevel = async (percent: number) => {
    try {
      await fetch(`${SPOTIFY_API}/player/volume?volume_percent=${Math.round(percent)}`, { method: "PUT" });
      setVolume(percent);
    } catch (e) {
      console.error("Failed to set volume:", e);
    }
  };

  const playPlaylist = async (uri: string) => {
    try {
      await fetch(`${SPOTIFY_API}/player/play?context_uri=${encodeURIComponent(uri)}`, { method: "PUT" });
      setIsPlaying(true);
      setTimeout(fetchPlayerState, 500);
    } catch (e) {
      console.error("Failed to play playlist:", e);
    }
  };

  const playTrack = async (uri: string) => {
    try {
      await fetch(`${SPOTIFY_API}/player/play?uri=${encodeURIComponent(uri)}`, { method: "PUT" });
      setIsPlaying(true);
      setTimeout(fetchPlayerState, 500);
    } catch (e) {
      console.error("Failed to play track:", e);
    }
  };

  // Search
  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults({ tracks: [], albums: [], artists: [] });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=track,album,artist&limit=6`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults({
          tracks: (data.tracks?.items || []).map((t: any) => ({
            id: t.id,
            name: t.name,
            artist: t.artists?.map((a: any) => a.name).join(", ") || "Unknown",
            artistId: t.artists?.[0]?.id || "",
            album: t.album?.name || "Unknown",
            albumArt: t.album?.images?.[0]?.url || "",
            uri: t.uri,
          })),
          albums: (data.albums?.items || []).map((a: any) => ({
            id: a.id,
            name: a.name,
            artist: a.artists?.map((ar: any) => ar.name).join(", ") || "Unknown",
            artistId: a.artists?.[0]?.id || "",
            image: a.images?.[0]?.url || "",
            uri: a.uri,
            releaseDate: a.release_date || "",
          })),
          artists: (data.artists?.items || []).map((ar: any) => ({
            id: ar.id,
            name: ar.name,
            image: ar.images?.[0]?.url || "",
            followers: ar.followers?.total || 0,
          })),
        });
      }
    } catch (e) {
      console.error("Failed to search:", e);
    }
    setLoading(false);
  };

  // Open artist page
  const openArtist = async (artistId: string) => {
    if (!artistId) return;
    setLoading(true);
    try {
      const artistRes = await fetch(`${SPOTIFY_API}/artist/${artistId}`);
      if (artistRes.ok) {
        const artist = await artistRes.json();

        // Try to get albums, but don't fail if it doesn't work
        let albums: { id: string; name: string; image: string; uri: string; releaseDate: string; type: string }[] = [];
        try {
          const albumsRes = await fetch(`${SPOTIFY_API}/artist/${artistId}/albums`);
          if (albumsRes.ok) {
            const albumsData = await albumsRes.json();
            console.log("Albums data:", albumsData.items?.map((a: any) => ({ name: a.name, type: a.album_type })));
            albums = (albumsData.items || []).map((a: any) => ({
              id: a.id,
              name: a.name,
              image: a.images?.[0]?.url || "",
              uri: a.uri,
              releaseDate: a.release_date || "",
              type: a.album_type || "album",
            }));
          } else {
            const errText = await albumsRes.text();
            console.error("Albums API error:", albumsRes.status, errText);
          }
        } catch (albumErr) {
          console.error("Albums fetch error:", albumErr);
        }

        setArtistView({
          id: artist.id,
          name: artist.name,
          image: artist.images?.[0]?.url || "",
          followers: artist.followers?.total || 0,
          albums,
        });
        if (activeTab !== "artist") setPreviousTab(activeTab as "playing" | "playlists" | "search");
        setActiveTab("artist");
      } else {
        console.error("Artist API error:", artistRes.status);
      }
    } catch (e) {
      console.error("Failed to get artist:", e);
    }
    setLoading(false);
  };

  // Open album page
  const openAlbum = async (albumId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${SPOTIFY_API}/album/${albumId}`);
      if (res.ok) {
        const album = await res.json();
        setAlbumView({
          id: album.id,
          name: album.name,
          image: album.images?.[0]?.url || "",
          artist: album.artists?.map((a: any) => a.name).join(", ") || "Unknown",
          artistId: album.artists?.[0]?.id || "",
          uri: album.uri,
          releaseDate: album.release_date || "",
          tracks: (album.tracks?.items || []).map((t: any) => ({
            id: t.id,
            name: t.name,
            uri: t.uri,
            duration: t.duration_ms || 0,
            trackNumber: t.track_number || 1,
          })),
        });
        if (activeTab !== "album" && activeTab !== "artist") setPreviousTab(activeTab as "playing" | "playlists" | "search");
        setActiveTab("album");
      }
    } catch (e) {
      console.error("Failed to get album:", e);
    }
    setLoading(false);
  };

  // Start OAuth login
  const handleConnect = async () => {
    try {
      const isLocal = window.location.hostname === "localhost";
      const res = await fetch(`${SPOTIFY_API}/login?local=${isLocal}`);
      if (res.ok) {
        const data = await res.json();
        // Open Spotify auth in popup
        const popup = window.open(data.auth_url, "spotify-auth", "width=500,height=700");

        // Listen for callback
        const checkPopup = setInterval(() => {
          try {
            if (popup?.closed) {
              clearInterval(checkPopup);
              // Check if we got authenticated
              fetch(`${SPOTIFY_API}/token`).then(r => r.json()).then(d => {
                if (d.access_token) {
                  onConnect();
                }
              });
            }
            // Check if popup redirected to our callback
            if (popup?.location?.href?.includes("/callback")) {
              const url = new URL(popup.location.href);
              const code = url.searchParams.get("code");
              if (code) {
                clearInterval(checkPopup);
                popup.close();
                // Exchange code for token
                const isLocal = window.location.hostname === "localhost";
                fetch(`${SPOTIFY_API}/callback?code=${code}&local=${isLocal}`).then(r => {
                  if (r.ok) {
                    onConnect();
                  }
                });
              }
            }
          } catch (e) {
            // Cross-origin error - popup is on Spotify's domain, wait for redirect
          }
        }, 500);
      }
    } catch (e) {
      console.error("Failed to start OAuth:", e);
    }
  };

  if (!isConnected) {
    return (
      <div style={{ width: 280, minWidth: 280, background: T.bg0, borderLeft: `1px solid ${T.border}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}>
        <BsSpotify size={48} color="#1DB954" />
        <div style={{ fontSize: 16, fontWeight: 600, color: T.text, textAlign: "center" }}>Connect Spotify</div>
        <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", lineHeight: 1.5 }}>
          Stream music to your call with Spotify integration
        </div>
        <button
          onClick={handleConnect}
          style={{
            background: "#1DB954",
            border: "none",
            borderRadius: 20,
            padding: "10px 24px",
            color: "#000",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: T.font,
          }}
        >
          <BsSpotify size={18} />
          Connect
        </button>
      </div>
    );
  }

  return (
    <div style={{ width: 280, minWidth: 280, background: T.bg0, borderLeft: `1px solid ${T.border}`, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8 }}>
        <BsSpotify size={20} color="#1DB954" />
        <span style={{ fontSize: 13, fontWeight: 600, color: T.text, flex: 1 }}>{user?.name || "Spotify"}</span>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#1DB954" }} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
        {[
          { id: "playing" as const, icon: null, label: "Now Playing" },
          { id: "playlists" as const, icon: <BsMusicNoteList size={14} />, label: "Playlists" },
          { id: "search" as const, icon: <BsSearch size={14} />, label: "Search" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1,
              padding: "10px 8px",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === tab.id ? "2px solid #1DB954" : "2px solid transparent",
              color: activeTab === tab.id ? "#1DB954" : T.textMuted,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 500,
              fontFamily: T.font,
              transition: "all 0.15s",
            }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {activeTab === "playing" && (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Album Art */}
            <div style={{ position: "relative", aspectRatio: "1", borderRadius: 8, overflow: "hidden", background: T.bg2 }}>
              {currentTrack?.albumArt ? (
                <img src={currentTrack.albumArt} alt={currentTrack.album} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <BsSpotify size={64} color={T.textMuted} />
                </div>
              )}
            </div>

            {/* Track Info */}
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {currentTrack?.name || "No track playing"}
              </div>
              <div
                style={{ fontSize: 12, color: T.textSoft, cursor: currentTrack?.artistId ? "pointer" : "default" }}
                onClick={() => currentTrack?.artistId && openArtist(currentTrack.artistId)}
                onMouseEnter={(e) => currentTrack?.artistId && (e.currentTarget.style.textDecoration = "underline")}
                onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
              >
                {currentTrack?.artist || "Open Spotify to play music"}
              </div>
            </div>

            {/* Progress Bar */}
            <div>
              <div
                style={{ height: 4, background: T.bg3, borderRadius: 2, cursor: "pointer", position: "relative" }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = ((e.clientX - rect.left) / rect.width) * 100;
                  seek(Math.max(0, Math.min(100, pct)));
                }}
              >
                <div style={{ width: `${progress}%`, height: "100%", background: "#1DB954", borderRadius: 2, position: "relative" }}>
                  <div style={{ position: "absolute", right: -4, top: -2, width: 8, height: 8, borderRadius: "50%", background: T.text }} />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: T.textMuted }}>
                <span>{formatTime(currentTrack?.progress || 0)}</span>
                <span>{formatTime(currentTrack?.duration || 0)}</span>
              </div>
            </div>

            {/* Controls */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <SpotifyControlBtn onClick={toggleShuffle} active={shuffle} size={28}>
                <BsShuffle size={14} />
              </SpotifyControlBtn>
              <SpotifyControlBtn onClick={skipPrevious} size={36}>
                <BsSkipStartFill size={20} />
              </SpotifyControlBtn>
              <button
                onClick={togglePlay}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: T.text,
                  border: "none",
                  color: T.bg0,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {isPlaying ? <BsPauseFill size={22} /> : <BsPlayFill size={22} style={{ marginLeft: 2 }} />}
              </button>
              <SpotifyControlBtn onClick={skipNext} size={36}>
                <BsSkipEndFill size={20} />
              </SpotifyControlBtn>
              <SpotifyControlBtn onClick={cycleRepeat} active={repeat !== "off"} size={28}>
                {repeat === "track" ? <BsRepeat1 size={14} /> : <BsRepeat size={14} />}
              </SpotifyControlBtn>
            </div>

            {/* Volume */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px" }}>
              <HiVolumeUp size={16} color={T.textSoft} />
              <div
                style={{ flex: 1, height: 4, background: T.bg3, borderRadius: 2, cursor: "pointer" }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = ((e.clientX - rect.left) / rect.width) * 100;
                  setVolumeLevel(Math.max(0, Math.min(100, pct)));
                }}
              >
                <div style={{ width: `${volume}%`, height: "100%", background: T.textSoft, borderRadius: 2 }} />
              </div>
            </div>

            {/* Stream to Call Button */}
            <button
              onClick={async () => {
                try {
                  setBotLoading(true);
                  if (botInCall) {
                    await fetch(`${SPOTIFY_API}/bot/leave`, { method: "POST" });
                    setBotInCall(false);
                  } else {
                    const res = await fetch(`${SPOTIFY_API}/bot/join`, { method: "POST" });
                    if (res.ok) {
                      setBotInCall(true);
                    }
                  }
                } catch (e) {
                  console.error("Bot error:", e);
                }
                setBotLoading(false);
              }}
              disabled={botLoading}
              style={{
                width: "100%",
                marginTop: 12,
                padding: "10px",
                background: botInCall ? T.bg3 : "#1DB954",
                border: "none",
                borderRadius: 20,
                color: botInCall ? T.text : "#000",
                fontSize: 12,
                fontWeight: 600,
                cursor: botLoading ? "wait" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                fontFamily: T.font,
                opacity: botLoading ? 0.6 : 1,
              }}
            >
              <IoCall size={16} />
              {botLoading ? "..." : botInCall ? "Leave Call" : "Stream to Call"}
            </button>
          </div>
        )}

        {activeTab === "playlists" && (
          <div style={{ padding: 8 }}>
            {playlists.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: T.textMuted, fontSize: 12 }}>
                Loading playlists...
              </div>
            ) : (
              playlists.map((playlist, idx) => (
                <div
                  key={playlist.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: hoverPlaylist === idx ? T.bg2 : "transparent",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={() => setHoverPlaylist(idx)}
                  onMouseLeave={() => setHoverPlaylist(null)}
                  onClick={() => playPlaylist(playlist.uri)}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 4,
                      background: playlist.image ? `url(${playlist.image}) center/cover` : `linear-gradient(135deg, #1DB954, #191414)`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {!playlist.image && <BsMusicNoteList size={18} color="#fff" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {playlist.name}
                    </div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>{playlist.tracks} tracks</div>
                  </div>
                  {hoverPlaylist === idx && (
                    <button
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: "#1DB954",
                        border: "none",
                        color: "#000",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        playPlaylist(playlist.uri);
                      }}
                    >
                      <BsPlayFill size={16} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "search" && (
          <div style={{ padding: 16 }}>
            <div style={{ position: "relative" }}>
              <BsSearch
                size={14}
                color={T.textMuted}
                style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }}
              />
              <input
                placeholder="Search songs, artists..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 12px 10px 36px",
                  background: T.bg2,
                  border: `1px solid ${T.border}`,
                  borderRadius: 20,
                  color: T.text,
                  fontSize: 13,
                  fontFamily: T.font,
                  outline: "none",
                }}
              />
            </div>
            {loading ? (
              <div style={{ marginTop: 24, textAlign: "center", color: T.textMuted, fontSize: 12 }}>
                Searching...
              </div>
            ) : (searchResults.tracks.length > 0 || searchResults.albums.length > 0 || searchResults.artists.length > 0) ? (
              <div style={{ marginTop: 12 }}>
                {/* Artists Section */}
                {searchResults.artists.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Artists</div>
                    {searchResults.artists.map((artist) => (
                      <div
                        key={artist.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px",
                          borderRadius: 6,
                          cursor: "pointer",
                          transition: "background 0.15s",
                        }}
                        onClick={() => openArtist(artist.id)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <div style={{ width: 40, height: 40, borderRadius: "50%", background: artist.image ? `url(${artist.image}) center/cover` : T.bg3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {!artist.image && <BsPersonFill size={18} color={T.textMuted} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {artist.name}
                          </div>
                          <div style={{ fontSize: 11, color: T.textMuted }}>Artist</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Albums Section */}
                {searchResults.albums.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Albums</div>
                    {searchResults.albums.map((album) => (
                      <div
                        key={album.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px",
                          borderRadius: 6,
                          cursor: "pointer",
                          transition: "background 0.15s",
                        }}
                        onClick={() => openAlbum(album.id)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <img src={album.image} alt="" style={{ width: 40, height: 40, borderRadius: 4, objectFit: "cover" }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {album.name}
                          </div>
                          <div style={{ fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {album.artist}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Tracks Section */}
                {searchResults.tracks.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Songs</div>
                    {searchResults.tracks.map((track) => (
                      <div
                        key={track.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px",
                          borderRadius: 6,
                          cursor: "pointer",
                          transition: "background 0.15s",
                        }}
                        onClick={() => playTrack(track.uri)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <img src={track.albumArt} alt="" style={{ width: 40, height: 40, borderRadius: 4, objectFit: "cover" }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {track.name}
                          </div>
                          <div
                            style={{ fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                            onClick={(e) => { e.stopPropagation(); openArtist(track.artistId); }}
                            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                          >
                            {track.artist}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : searchQuery ? (
              <div style={{ marginTop: 24, textAlign: "center", color: T.textMuted, fontSize: 12 }}>
                No results found
              </div>
            ) : (
              <div style={{ marginTop: 24, textAlign: "center", color: T.textMuted, fontSize: 12 }}>
                Search for songs, artists, or albums
              </div>
            )}
          </div>
        )}

        {/* Artist Page */}
        {activeTab === "artist" && artistView && (
          <div style={{ padding: 0 }}>
            {/* Back button */}
            <div
              style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: T.textMuted, fontSize: 12 }}
              onClick={() => { setActiveTab(previousTab); setArtistView(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
              onMouseLeave={(e) => (e.currentTarget.style.color = T.textMuted)}
            >
              <BsChevronLeft size={14} /> Back
            </div>

            {/* Artist Header */}
            <div style={{ padding: "0 16px 16px", textAlign: "center" }}>
              <div style={{ width: 100, height: 100, borderRadius: "50%", margin: "0 auto 12px", background: artistView.image ? `url(${artistView.image}) center/cover` : T.bg3, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {!artistView.image && <BsPersonFill size={40} color={T.textMuted} />}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: T.text }}>{artistView.name}</div>
            </div>

            {/* Albums & Singles */}
            <div style={{ padding: "0 8px 16px" }}>
              {/* Albums */}
              {artistView.albums.filter(a => a.type === "album" || a.type === "compilation").length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, padding: "0 8px", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Albums</div>
                  {artistView.albums.filter(a => a.type === "album" || a.type === "compilation").map((album) => (
                    <div
                      key={album.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px",
                        borderRadius: 6,
                        cursor: "pointer",
                        transition: "background 0.15s",
                      }}
                      onClick={() => openAlbum(album.id)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <img src={album.image} alt="" style={{ width: 48, height: 48, borderRadius: 4, objectFit: "cover" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {album.name}
                        </div>
                        <div style={{ fontSize: 11, color: T.textMuted }}>{album.releaseDate?.split("-")[0]}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Singles */}
              {artistView.albums.filter(a => a.type === "single").length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, padding: "0 8px", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Singles & EPs</div>
                  {artistView.albums.filter(a => a.type === "single").map((album) => (
                    <div
                      key={album.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px",
                        borderRadius: 6,
                        cursor: "pointer",
                        transition: "background 0.15s",
                      }}
                      onClick={() => openAlbum(album.id)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <img src={album.image} alt="" style={{ width: 48, height: 48, borderRadius: 4, objectFit: "cover" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {album.name}
                        </div>
                        <div style={{ fontSize: 11, color: T.textMuted }}>{album.releaseDate?.split("-")[0]}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Album Page */}
        {activeTab === "album" && albumView && (
          <div style={{ padding: 0 }}>
            {/* Back button */}
            <div
              style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: T.textMuted, fontSize: 12 }}
              onClick={() => { setActiveTab(artistView ? "artist" : previousTab); setAlbumView(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
              onMouseLeave={(e) => (e.currentTarget.style.color = T.textMuted)}
            >
              <BsChevronLeft size={14} /> Back
            </div>

            {/* Album Header */}
            <div style={{ padding: "0 16px 16px" }}>
              <img src={albumView.image} alt="" style={{ width: "100%", aspectRatio: "1", borderRadius: 8, objectFit: "cover", marginBottom: 12 }} />
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>{albumView.name}</div>
              <div
                style={{ fontSize: 12, color: T.textMuted, cursor: "pointer" }}
                onClick={() => openArtist(albumView.artistId)}
                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
              >
                {albumView.artist}
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{albumView.releaseDate?.split("-")[0]} • {albumView.tracks.length} tracks</div>

              {/* Play Album Button */}
              <button
                onClick={() => playPlaylist(albumView.uri)}
                style={{
                  width: "100%",
                  marginTop: 12,
                  padding: "10px",
                  background: "#1DB954",
                  border: "none",
                  borderRadius: 20,
                  color: "#000",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  fontFamily: T.font,
                }}
              >
                <BsPlayFill size={18} /> Play
              </button>
            </div>

            {/* Track List */}
            <div style={{ padding: "0 8px 16px" }}>
              {albumView.tracks.map((track) => (
                <div
                  key={track.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 8px",
                    borderRadius: 6,
                    cursor: "pointer",
                    transition: "background 0.15s",
                  }}
                  onClick={() => playTrack(track.uri)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: 12, color: T.textMuted, width: 20, textAlign: "center" }}>{track.trackNumber}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {track.name}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: T.textMuted }}>{formatTime(track.duration)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FriendItem({ friend, active, onClick, onContextMenu }: { friend: { id: number; name: string; status: string; activity: string | null; color: string; unread: number }; active: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void }) {
  const [h, setH] = useState(false);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, cursor: "pointer", background: active ? T.bg3 : h ? T.bg2 : "transparent", transition: "background 0.12s", opacity: friend.status === "offline" ? 0.5 : 1 }}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={onClick} onContextMenu={onContextMenu}
    >
      <div style={{ position: "relative" }}>
        <div style={{ ...s.avatar, background: friend.color }}>{friend.name[0]}</div>
        <div style={{ ...s.dot, background: statusColor(friend.status) }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: active ? T.text : friend.status === "offline" ? T.textMuted : T.text }}>{friend.name}</div>
        {friend.activity && <div style={{ fontSize: 11, color: T.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{friend.activity}</div>}
      </div>
      {friend.unread > 0 && <div style={s.unreadBadge}>{friend.unread}</div>}
    </div>
  );
}

function Msg({ msg, myUsername, onContextMenu, isFirst }: { msg: { id: number; from: string; time: string; text: string }; myUsername: string; onContextMenu: (e: React.MouseEvent) => void; isFirst: boolean }) {
  const [h, setH] = useState(false);
  const isMe = msg.from === "me";
  const displayName = isMe ? myUsername : msg.from;
  // Get avatar and name color based on the actual username
  const avatarColor = getAvatarByUsername(displayName);
  const nameColor = getNameColorByUsername(displayName);
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        padding: isFirst ? "12px 24px 4px" : "2px 24px 2px 82px",
        background: h ? "rgba(255,255,255,0.02)" : "transparent",
        transition: "background 0.1s",
        position: "relative",
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      onContextMenu={onContextMenu}
    >
      {isFirst ? (
        <div style={{ ...s.avatar, width: 40, height: 40, background: avatarColor, fontSize: 15, marginTop: 2, flexShrink: 0 }}>
          {displayName[0].toUpperCase()}
        </div>
      ) : (
        h && <span style={{ position: "absolute", left: 24, fontSize: 10, color: T.textMuted }}>{msg.time.split(" ")[0]}</span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {isFirst && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: nameColor, cursor: "pointer" }}>{displayName}</span>
            <span style={{ fontSize: 11, color: T.textMuted }}>{msg.time}</span>
          </div>
        )}
        <div style={{ fontSize: 14, color: T.text, lineHeight: 1.45 }}>{msg.text}</div>
      </div>
      {h && (
        <div style={s.msgActions}>
          <span style={s.msgAction}><BsEmojiSmile size={14} /></span>
          <span style={s.msgAction}><HiReply size={14} /></span>
          <span style={s.msgAction}><HiDotsHorizontal size={14} /></span>
        </div>
      )}
    </div>
  );
}


function CallBtnWithDropdown({ icon, onClick, active, tooltip, colorMode = "default", dropdownItems }: { icon: React.ReactNode; onClick: () => void; active?: boolean; tooltip: string; colorMode?: "default" | "red" | "green"; dropdownItems: { label: string; onClick: () => void }[] }) {
  const [h, setH] = useState(false);
  const [hDrop, setHDrop] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<number | null>(null);

  // Determine colors based on colorMode and active state
  const isColored = active && colorMode !== "default";
  const baseColor = colorMode === "red" ? T.red : colorMode === "green" ? T.green : T.bg4;
  const softColor = colorMode === "red" ? "rgba(239,68,68,0.15)" : colorMode === "green" ? "rgba(52,211,153,0.15)" : T.bg3;
  const hoverPrimary = colorMode === "red" ? "rgba(239,68,68,0.25)" : colorMode === "green" ? "rgba(52,211,153,0.25)" : T.bg4;

  // Background logic: if active with color, use colored backgrounds. Otherwise use gray.
  // Secondary hover stays at softColor (same as non-hovered), not dimmer
  const getMainBg = () => {
    if (isColored) return h ? hoverPrimary : softColor;
    return h ? T.bg4 : hDrop ? "rgba(37,37,52,0.6)" : T.bg3;
  };
  const getDropBg = () => {
    if (isColored) return hDrop || menuOpen ? hoverPrimary : softColor;
    return hDrop || menuOpen ? T.bg4 : h ? "rgba(37,37,52,0.6)" : T.bg3;
  };

  // Gap background - only visible when hovering or active
  const isHovering = h || hDrop;
  const gapBg = isHovering || isColored ? "transparent" : (isColored ? softColor : T.bg3);

  return (
    <div style={{ position: "relative", display: "flex" }}>
      <div style={{ ...s.callBtnGroup, background: gapBg, borderRadius: 12 }}>
        <button
          style={{
            ...s.callControlBtn,
            borderRadius: "12px 0 0 12px",
            background: getMainBg(),
            color: isColored ? baseColor : T.text,
            borderColor: "transparent",
            borderRight: "none",
          }}
          onMouseEnter={() => setH(true)}
          onMouseLeave={() => setH(false)}
          onClick={onClick}
        >
          {icon}
        </button>
        <button
          style={{
            ...s.callControlDropdown,
            background: getDropBg(),
            color: isColored ? baseColor : T.textSoft,
            borderColor: "transparent",
          }}
          onMouseEnter={() => setHDrop(true)}
          onMouseLeave={() => setHDrop(false)}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <IoChevronDown size={12} style={{ transform: menuOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }} />
        </button>
      </div>
      {(h || hDrop) && !menuOpen && (
        <div style={s.tooltip}>
          {tooltip}
          <div style={s.tooltipArrow} />
        </div>
      )}
      {menuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setMenuOpen(false)} />
          <div style={s.callDropdownMenu}>
            {dropdownItems.map((item, idx) => (
              <div
                key={idx}
                style={{
                  padding: "8px 12px",
                  fontSize: 13,
                  color: hoveredItem === idx ? T.text : T.textSoft,
                  background: hoveredItem === idx ? T.bg4 : "transparent",
                  borderRadius: 6,
                  cursor: "pointer",
                  transition: "all 0.1s",
                }}
                onMouseEnter={() => setHoveredItem(idx)}
                onMouseLeave={() => setHoveredItem(null)}
                onClick={() => { item.onClick(); setMenuOpen(false); }}
              >
                {item.label}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Video element component for displaying video streams
function VideoElement({ stream, muted = false, mirrored = false }: { stream: MediaStream | null; muted?: boolean; mirrored?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  if (!stream) return null;

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: mirrored ? "scaleX(-1)" : "none",
      }}
    />
  );
}

// Audio level meter component
function AudioLevelMeter({ level }: { level: number }) {
  const bars = 24;
  return (
    <div style={{ display: "flex", gap: 3, height: 24, alignItems: "flex-end" }}>
      {Array.from({ length: bars }).map((_, i) => {
        const threshold = (i / bars) * 100;
        const isActive = level > threshold;
        const color = i < bars * 0.6 ? T.green : i < bars * 0.85 ? T.orange : T.red;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: "100%",
              borderRadius: 2,
              background: isActive ? color : T.bg4,
              transition: "background 0.05s",
            }}
          />
        );
      })}
    </div>
  );
}

// Microphone button with audio device selector
function MicrophoneButton({
  isMuted,
  onToggleMute,
  inputDevices,
  outputDevices,
  selectedInputId,
  selectedOutputId,
  onSelectInput,
  onSelectOutput,
  audioLevel,
  onStartMonitoring,
  onStopMonitoring,
  onRefreshDevices,
}: {
  isMuted: boolean;
  onToggleMute: () => void;
  inputDevices: AudioDevice[];
  outputDevices: AudioDevice[];
  selectedInputId: string;
  selectedOutputId: string;
  onSelectInput: (deviceId: string) => void;
  onSelectOutput: (deviceId: string) => void;
  audioLevel: number;
  onStartMonitoring: () => void;
  onStopMonitoring: () => void;
  onRefreshDevices: () => void;
}) {
  const [h, setH] = useState(false);
  const [hDrop, setHDrop] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  // Start monitoring when menu opens, stop when it closes
  useEffect(() => {
    if (menuOpen) {
      onRefreshDevices();
      onStartMonitoring();
    } else {
      onStopMonitoring();
    }
  }, [menuOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const isColored = isMuted;
  const baseColor = T.red;
  const softColor = "rgba(239,68,68,0.15)";
  const hoverPrimary = "rgba(239,68,68,0.25)";

  const getMainBg = () => {
    if (isColored) return h ? hoverPrimary : softColor;
    return h ? T.bg4 : hDrop ? "rgba(37,37,52,0.6)" : T.bg3;
  };
  const getDropBg = () => {
    if (isColored) return hDrop || menuOpen ? hoverPrimary : softColor;
    return hDrop || menuOpen ? T.bg4 : h ? "rgba(37,37,52,0.6)" : T.bg3;
  };

  const isHovering = h || hDrop;
  const gapBg = isHovering || isColored ? "transparent" : (isColored ? softColor : T.bg3);

  return (
    <div style={{ position: "relative", display: "flex" }}>
      <div style={{ ...s.callBtnGroup, background: gapBg, borderRadius: 12 }}>
        <button
          style={{
            ...s.callControlBtn,
            borderRadius: "12px 0 0 12px",
            background: getMainBg(),
            color: isColored ? baseColor : T.text,
            borderColor: "transparent",
            borderRight: "none",
          }}
          onMouseEnter={() => setH(true)}
          onMouseLeave={() => setH(false)}
          onClick={onToggleMute}
        >
          {isMuted ? <FaMicrophoneSlash size={20} /> : <TiMicrophone size={20} />}
        </button>
        <button
          style={{
            ...s.callControlDropdown,
            background: getDropBg(),
            color: isColored ? baseColor : T.textSoft,
            borderColor: "transparent",
          }}
          onMouseEnter={() => setHDrop(true)}
          onMouseLeave={() => setHDrop(false)}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <IoChevronDown size={12} style={{ transform: menuOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }} />
        </button>
      </div>
      {(h || hDrop) && !menuOpen && (
        <div style={s.tooltip}>
          {isMuted ? "Unmute" : "Mute"}
          <div style={s.tooltipArrow} />
        </div>
      )}
      {menuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setMenuOpen(false)} />
          <div style={{ ...s.callDropdownMenu, minWidth: 280, padding: 12 }}>
            {/* Audio Level Tester */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Microphone Test
              </div>
              <div style={{ padding: "12px", background: T.bg2, borderRadius: 8 }}>
                <AudioLevelMeter level={audioLevel} />
              </div>
            </div>

            {/* Input Devices */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Input Device
              </div>
              {inputDevices.length === 0 ? (
                <div style={{ fontSize: 12, color: T.textMuted, padding: "8px 0" }}>No microphones found</div>
              ) : (
                inputDevices.map((device) => (
                  <div
                    key={device.deviceId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      fontSize: 13,
                      color: hoveredItem === `in-${device.deviceId}` ? T.text : T.textSoft,
                      background: hoveredItem === `in-${device.deviceId}` ? T.bg4 : "transparent",
                      borderRadius: 6,
                      cursor: "pointer",
                      transition: "all 0.1s",
                    }}
                    onMouseEnter={() => setHoveredItem(`in-${device.deviceId}`)}
                    onMouseLeave={() => setHoveredItem(null)}
                    onClick={() => onSelectInput(device.deviceId)}
                  >
                    <div style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border: `2px solid ${selectedInputId === device.deviceId ? T.accent : T.textMuted}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      {selectedInputId === device.deviceId && (
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent }} />
                      )}
                    </div>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {device.label}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Output Devices */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Output Device
              </div>
              {outputDevices.length === 0 ? (
                <div style={{ fontSize: 12, color: T.textMuted, padding: "8px 0" }}>No speakers found</div>
              ) : (
                outputDevices.map((device) => (
                  <div
                    key={device.deviceId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      fontSize: 13,
                      color: hoveredItem === `out-${device.deviceId}` ? T.text : T.textSoft,
                      background: hoveredItem === `out-${device.deviceId}` ? T.bg4 : "transparent",
                      borderRadius: 6,
                      cursor: "pointer",
                      transition: "all 0.1s",
                    }}
                    onMouseEnter={() => setHoveredItem(`out-${device.deviceId}`)}
                    onMouseLeave={() => setHoveredItem(null)}
                    onClick={() => onSelectOutput(device.deviceId)}
                  >
                    <div style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border: `2px solid ${selectedOutputId === device.deviceId ? T.accent : T.textMuted}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      {selectedOutputId === device.deviceId && (
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent }} />
                      )}
                    </div>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {device.label}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EndCallBtn({ onClick }: { onClick: () => void }) {
  const [h, setH] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        style={{ ...s.endCallBtn, background: h ? "#dc2626" : T.red, width: 72 }}
        onMouseEnter={() => setH(true)}
        onMouseLeave={() => setH(false)}
        onClick={onClick}
      >
        <ImPhoneHangUp size={24} />
      </button>
      {h && (
        <div style={s.tooltip}>
          Disconnect
          <div style={s.tooltipArrow} />
        </div>
      )}
    </div>
  );
}

function FullscreenBtn({ isFullscreen, onClick }: { isFullscreen: boolean; onClick: () => void }) {
  const [_h, setH] = useState(false);
  return (
    <button
      style={s.fullscreenBtn}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      onClick={onClick}
    >
      {isFullscreen ? <GoScreenNormal size={24} /> : <GoScreenFull size={24} />}
    </button>
  );
}

function GifPicker({ onClose }: { onClose: () => void }) {
  const gifs = ["Funny cat", "Mind blown", "Thumbs up", "Dancing", "Facepalm", "Celebration", "Eye roll", "High five", "Slow clap"];
  return (
    <div style={s.gifPicker}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>GIFs</span>
        <button style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 14, lineHeight: 1 }} onClick={onClose}>x</button>
      </div>
      <input style={{ ...s.searchInput, marginBottom: 8 }} placeholder="Search GIFs..." />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, maxHeight: 200, overflowY: "auto" }}>
        {gifs.map((g, i) => (
          <div key={i} style={{ aspectRatio: "1", background: T.bg3, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11, color: T.textSoft, textAlign: "center", padding: 4 }}>{g}</div>
        ))}
      </div>
    </div>
  );
}

function ContextMenu({ x, y, type, data: _data, onClose }: { x: number; y: number; type: string; data?: any; onClose: () => void }) {
  const [hoveredItem, setHoveredItem] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjust position if menu would go off screen
  const adjustedX = Math.min(x, window.innerWidth - 200);
  const adjustedY = Math.min(y, window.innerHeight - 300);

  const menuItems = type === "message" ? [
    { icon: <HiReply size={14} />, label: "Reply", action: () => {} },
    { icon: <FaCopy size={13} />, label: "Copy Text", action: () => {} },
    { icon: <BsPinAngleFill size={13} />, label: "Pin Message", action: () => {} },
    { divider: true },
    { icon: <HiTrash size={14} />, label: "Delete Message", danger: true, action: () => {} },
  ] : type === "friend" ? [
    { icon: <HiChatAlt2 size={14} />, label: "Message", action: () => {} },
    { icon: <HiPhone size={14} />, label: "Start Call", action: () => {} },
    { divider: true },
    { icon: <HiUserCircle size={14} />, label: "View Profile", action: () => {} },
    { icon: <HiPencil size={14} />, label: "Edit Nickname", action: () => {} },
    { divider: true },
    { icon: <HiVolumeUp size={14} />, label: "Mute", action: () => {} },
    { icon: <HiBan size={14} />, label: "Block", danger: true, action: () => {} },
  ] : [
    { icon: <IoRefresh size={14} />, label: "Refresh", action: () => {} },
    { icon: <IoSettings size={14} />, label: "Settings", action: () => {} },
    { divider: true },
    { icon: <FaCopy size={13} />, label: "Copy", action: () => {} },
    { icon: <FaPaste size={13} />, label: "Paste", action: () => {} },
  ];

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: adjustedY,
        left: adjustedX,
        background: T.bg3,
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: 4,
        minWidth: 180,
        boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        zIndex: 1000,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {menuItems.map((item, idx) =>
        item.divider ? (
          <div key={idx} style={{ height: 1, background: T.border, margin: "4px 8px" }} />
        ) : (
          <div
            key={idx}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              cursor: "pointer",
              fontSize: 13,
              borderRadius: 6,
              color: item.danger ? T.red : hoveredItem === idx ? T.text : T.textSoft,
              background: hoveredItem === idx ? T.bg4 : "transparent",
              transition: "all 0.1s",
            }}
            onMouseEnter={() => setHoveredItem(idx)}
            onMouseLeave={() => setHoveredItem(null)}
            onClick={() => { item.action?.(); onClose(); }}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20 }}>{item.icon}</span>
            <span>{item.label}</span>
          </div>
        )
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const s = {
  app: { display: "flex", width: "100vw", height: "100vh", background: T.bg1, fontFamily: T.font, color: T.text, overflow: "hidden" } as const,

  leftPanel: { width: 280, minWidth: 280, background: T.bg0, display: "flex", flexDirection: "column" as const, borderRight: `1px solid ${T.border}` },
  userCard: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px 14px", borderTop: `1px solid ${T.border}` },
  userAvatarLg: { width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg, #f472b6, #fb923c)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, position: "relative" as const, flexShrink: 0, color: "#fff" },
  iconBtn: { background: "none", border: "none", color: T.textMuted, fontSize: 15, cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center" },
  searchInput: { width: "100%", padding: "8px 12px", background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontFamily: T.font, fontSize: 13 },
  tabs: { display: "flex", gap: 2, padding: "0 12px 8px" },
  tab: { flex: 1, padding: "6px 0", border: "none", borderRadius: 6, fontFamily: T.font, fontSize: 12, fontWeight: 500, cursor: "pointer", transition: "all 0.15s" },
  friendsList: { flex: 1, overflowY: "auto" as const, padding: "4px 8px" },
  sectionLabel: { fontSize: 10, fontWeight: 700, letterSpacing: 1, color: T.textMuted, padding: "8px 12px 4px" },
  addFriendBar: { padding: "10px 12px", borderTop: `1px solid ${T.border}` },
  addFriendBtn: { width: "100%", padding: "9px 0", background: T.accent, border: "none", borderRadius: 8, color: "#fff", fontFamily: T.font, fontSize: 13, fontWeight: 600, cursor: "pointer" },

  rightPanel: { flex: 1, display: "flex", flexDirection: "column" as const, minWidth: 0, background: T.bg1 },
  topBar: { height: 56, minHeight: 56, padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${T.border}`, background: T.bg1 },
  topBarBtn: { width: 32, height: 32, borderRadius: 8, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 15, fontFamily: T.font, transition: "all 0.15s" },
  callBtn: { display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", color: "#fff", fontFamily: T.font, fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" },

  callArea: { background: T.bg0, borderBottom: `1px solid ${T.border}`, display: "flex", flexDirection: "column" as const },
  callGrid: { display: "flex", gap: 8, padding: "12px", justifyContent: "center", alignItems: "center" },
  callTile: { width: "calc(50% - 4px)", maxWidth: 480, aspectRatio: "16/9", borderRadius: 12, background: T.bg2, position: "relative" as const, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tileName: { position: "absolute" as const, bottom: 8, left: 10, fontSize: 11, fontWeight: 600, color: T.textSoft, background: "rgba(0,0,0,0.5)", padding: "3px 8px", borderRadius: 4 },
  videoPlaceholder: { display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", color: T.textSoft },
  voicePlaceholder: { display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", color: T.text },
  screenSharePlaceholder: { display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", color: T.textSoft, background: `repeating-linear-gradient(45deg, ${T.bg2}, ${T.bg2} 10px, ${T.bg3} 10px, ${T.bg3} 20px)`, width: "100%", height: "100%" },
  avatarXl: { width: 64, height: 64, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 24, color: "#fff" },
  callControlsWrapper: { position: "relative" as const, display: "flex", alignItems: "center", justifyContent: "center", padding: "12px" },
  callControls: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8 },
  callControlBtn: { width: 48, height: 48, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, border: "1px solid transparent", cursor: "pointer", fontFamily: T.font, transition: "all 0.15s" },
  callBtnGroup: { display: "flex", gap: 2 },
  callControlDropdown: { width: 24, height: 48, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "0 12px 12px 0", border: "1px solid transparent", borderLeft: `1px solid rgba(255,255,255,0.1)`, cursor: "pointer", fontFamily: T.font, transition: "all 0.15s" },
  endCallBtn: { width: 48, height: 48, display: "flex", alignItems: "center", justifyContent: "center", background: T.red, border: "none", borderRadius: 12, color: "#fff", cursor: "pointer", transition: "all 0.15s" },
  fullscreenBtn: { position: "absolute" as const, right: 12, width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", transition: "all 0.15s" },
  callDropdownMenu: { position: "absolute" as const, top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)", background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: 4, minWidth: 160, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", zIndex: 100 },
  tooltip: { position: "absolute" as const, bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)", background: T.bg0, color: T.text, fontSize: 12, fontWeight: 500, padding: "6px 10px", borderRadius: 6, whiteSpace: "nowrap" as const, boxShadow: "0 4px 12px rgba(0,0,0,0.5)", zIndex: 100, border: `1px solid ${T.border}` },
  tooltipArrow: { position: "absolute" as const, bottom: -4, left: "50%", transform: "translateX(-50%) rotate(45deg)", width: 8, height: 8, background: T.bg0, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` },

  messagesArea: { flex: 1, overflowY: "auto" as const, paddingBottom: 8 },
  convoStart: { display: "flex", flexDirection: "column" as const, alignItems: "flex-start", padding: "32px 24px 8px" },
  convoStartAvatar: { position: "relative" as const },
  convoStartDivider: { display: "flex", alignItems: "center", width: "100%", marginTop: 20 },
  convoStartLine: { flex: 1, height: 1, background: T.border },
  avatar: { width: 34, height: 34, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: "#fff", flexShrink: 0, position: "relative" as const },
  dot: { position: "absolute" as const, bottom: 0, right: 0, width: 10, height: 10, borderRadius: "50%", border: `2px solid ${T.bg0}` },
  unreadBadge: { minWidth: 18, height: 18, padding: "0 5px", background: T.accent, borderRadius: 9, fontSize: 10, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" },
  msgActions: { position: "absolute" as const, right: 16, top: -12, display: "flex", gap: 1, background: T.bg3, borderRadius: 6, padding: 2, border: `1px solid ${T.border}`, boxShadow: "0 2px 8px rgba(0,0,0,0.3)" },
  msgAction: { width: 28, height: 28, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: T.textSoft, transition: "all 0.1s" },

  inputArea: { padding: "0 16px 16px" },
  inputRow: { display: "flex", alignItems: "center", background: T.bg2, borderRadius: 8, padding: "4px 4px 4px 4px" },
  inputIconBtn: { width: 36, height: 36, background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", fontFamily: T.font, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, transition: "all 0.1s" },
  inputActions: { display: "flex", alignItems: "center", gap: 2 },
  sendBtn: { width: 36, height: 36, background: T.accent, border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" },
  msgInput: { flex: 1, background: "transparent", border: "none", color: T.text, fontFamily: T.font, fontSize: 14, padding: "10px 8px", minWidth: 0 },
  gifBtn: { padding: "5px 10px", borderRadius: 6, border: "none", background: T.bg3, color: T.textSoft, cursor: "pointer", fontFamily: T.font, fontSize: 11, fontWeight: 700 },

  gifPicker: { position: "absolute" as const, bottom: 44, right: 0, width: 280, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 100 },
};
