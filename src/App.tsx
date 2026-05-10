import React, { useState, useRef, useEffect } from 'react';
import {
  Mic, Square, Download, Sparkles, Waves, Settings, X,
  Radio, Users, FileText, Zap, ChevronRight,
  Activity, PenLine, Save, AlertTriangle, CheckCircle2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { RealtimeClient } from '@speechmatics/real-time-client';
import api from './api';

interface Message {
  speaker: string;
  text: string;
  timestamp: number;
}

const SPEAKER_COLORS: Record<string, string> = {
  S1: 'var(--accent)',
  S2: 'var(--success)',
  S3: 'var(--warning)',
  S4: 'var(--danger)',
  S5: 'var(--accent-2)',
};

function getSpeakerColor(s: string) { return SPEAKER_COLORS[s] ?? 'var(--text-2)'; }
function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatElapsed(sec: number) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function MeetingPage() {
  const [isRecording, setIsRecording]     = useState(false);
  const [messages, setMessages]           = useState<Message[]>([]);
  const [summary, setSummary]             = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [showSummary, setShowSummary]     = useState(false);
  const [status, setStatus]               = useState('Ready');
  const [partialText, setPartialText]     = useState('');
  const [elapsed, setElapsed]             = useState(0);
  const [meetingTitle, setMeetingTitle]   = useState('New Meeting');
  const [editingTitle, setEditingTitle]   = useState(false);
  const [meetingId, setMeetingId]         = useState<string | null>(null);
  const [noteText, setNoteText]           = useState('');
  const [notes, setNotes]                 = useState<any[]>([]);
  const [toast, setToast]                 = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);
  const [totalSegments, setTotalSegments] = useState(0);   // reactive count of full transcript

  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef    = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef  = useRef<MediaStream | null>(null);   // ← keep ref to stop tracks
  const scrollRef       = useRef<HTMLDivElement>(null);
  const clientRef       = useRef<RealtimeClient | null>(null);
  const isRecordingRef      = useRef(false);
  const timerRef            = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef        = useRef<number>(0);
  const meetingTitleRef     = useRef<string>('New Meeting');   // avoids stale closure
  const allMessagesRef      = useRef<Message[]>([]);           // unbounded full transcript
  const savedSegCountRef    = useRef(0);                       // how many segs already persisted
  const autoSaveTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const meetingIdRef        = useRef<string | null>(null);     // mirror of meetingId state

  // Keep meetingTitleRef in sync with state
  useEffect(() => { meetingTitleRef.current = meetingTitle; }, [meetingTitle]);
  // Keep meetingIdRef in sync with state (needed inside interval callbacks)
  useEffect(() => { meetingIdRef.current = meetingId; }, [meetingId]);

  // ── Scroll to bottom on new content ───────────────────────────────
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, partialText]);

  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isRecording]);

  // ── Auto-save timer (every 90 s) ──────────────────────────────────
  // Saves only NEW segments since the last auto-save so the DB call
  // is always O(new segments), not O(all segments).
  const startAutoSave = (mid: string) => {
    if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setInterval(async () => {
      const all  = allMessagesRef.current;
      const from = savedSegCountRef.current;
      const newSegs = all.slice(from);
      if (newSegs.length === 0) return;
      try {
        await api.post(`/api/meetings/${mid}/segments`, {
          segments: newSegs.map(m => ({ speaker: m.speaker, text: m.text, timestamp: m.timestamp })),
        });
        savedSegCountRef.current = all.length;
        console.log(`[BanglaMeet] auto-saved ${newSegs.length} segments (total: ${all.length})`);
      } catch (err) {
        console.warn('[BanglaMeet] auto-save failed:', err);
      }
    }, 90_000); // every 90 seconds
  };

  const stopAutoSave = () => {
    if (autoSaveTimerRef.current) {
      clearInterval(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  };

  // ── Max visible messages in the transcript panel ───────────────────
  // We store ALL messages in allMessagesRef (unbounded, for DB save &
  // summarization), but only push the last RENDER_WINDOW into React
  // state to keep re-renders O(1) regardless of meeting length.
  const RENDER_WINDOW = 80;

  function showToast(msg: string, type: 'ok' | 'err' = 'ok') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  const startRecording = async () => {
    try {
      setStatus('Initializing…');
      setElapsed(0);
      setMessages([]);
      setNotes([]);
      setSummary(null);
      allMessagesRef.current   = [];   // reset full transcript
      savedSegCountRef.current = 0;    // reset save pointer
      setTotalSegments(0);             // reset reactive counter
      startTimeRef.current     = Date.now();

      // ── 1. Create meeting record ─────────────────────────────────
      const meetRes = await api.post('/api/meetings', { title: meetingTitle });
      const mid = meetRes.data.meeting.id;
      setMeetingId(mid);
      meetingIdRef.current = mid; // sync ref immediately (state update is async)

      // ── 2. Get mic stream ─────────────────────────────────────
      //   • echoCancellation / noiseSuppression / autoGainControl are
      //     intentionally DISABLED: Speechmatics has its own VAD/AGC
      //     pipeline and browser DSP introduces smearing artefacts that
      //     degrade Bangla speech recognition.
      //   • sampleRate hint: browsers honour this as a hint, not a
      //     guarantee; we read the actual rate from AudioContext below.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          // DO NOT set sampleRate here — it causes getSettings() to return
          // undefined on many devices, breaking AudioContext sampleRate detection.
          // We always create the AudioContext at 48000 Hz (universal hardware rate)
          // and let Speechmatics receive the correct sample_rate declaration.
        },
        video: false,
      });
      mediaStreamRef.current = stream;

      // ── 3. Build AudioContext at 48 kHz ──────────────────────────
      //   We fix at 48000 Hz (universal hardware rate on all major OS/drivers).
      //   Speechmatics accepts any sample rate via audio_format.sample_rate,
      //   so there is no resampling needed on either end.
      //   IMPORTANT: Do NOT use nativeSampleRate from getSettings() — it returns
      //   undefined on many devices when no sampleRate constraint was applied,
      //   and undefined passed to AudioContext causes silent fallback to 44100
      //   while we still tell Speechmatics 48000 → severe pitch/tempo mismatch.
      audioContextRef.current = new AudioContext({
        sampleRate: 48000,
        latencyHint: 'interactive',
      });

      // Guard: resume if Chrome auto-suspended on construction
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      // Guard: auto-resume if Chrome suspends mid-session (focus loss, etc.)
      audioContextRef.current.onstatechange = async () => {
        if (audioContextRef.current?.state === 'suspended' && isRecordingRef.current) {
          console.warn('[BanglaMeet] AudioContext suspended mid-session — resuming');
          await audioContextRef.current.resume();
        }
      };

      // ── 4. Fetch Speechmatics JWT ──────────────────────────────
      let smJwt: string;
      try {
        const tokenRes = await api.get('/api/speechmatics-token');
        smJwt = tokenRes.data.token;
      } catch {
        setStatus('Auth Error');
        // Clean up the stream we already acquired
        stream.getTracks().forEach(t => t.stop());
        audioContextRef.current.close();
        return;
      }

      // ── 5. Connect Speechmatics RT client ─────────────────────
      clientRef.current = new RealtimeClient();
      clientRef.current.addEventListener('receiveMessage', ({ data }: any) => {
        if (data.message === 'AddTranscript') {
          setPartialText('');
          let currentSpeaker = '';
          let currentText = '';
          const segments: { speaker: string; text: string }[] = [];

          data.results.forEach((r: any) => {
            const speaker = r.alternatives?.[0]?.speaker || 'S1';
            const word    = r.alternatives?.[0]?.content  || '';
            if (speaker !== currentSpeaker) {
              if (currentText) segments.push({ speaker: currentSpeaker, text: currentText.trim() });
              currentSpeaker = speaker;
              currentText    = word;
            } else {
              currentText += (r.type === 'word' ? ' ' : '') + word;
            }
          });
          if (currentText) segments.push({ speaker: currentSpeaker, text: currentText.trim() });

          // ── Append to full unbounded transcript ─────────────────
          allMessagesRef.current = (() => {
            const updated = [...allMessagesRef.current];
            segments.forEach(seg => {
              const last = updated[updated.length - 1];
              if (last && last.speaker === seg.speaker) {
                updated[updated.length - 1] = { ...last, text: last.text + ' ' + seg.text };
              } else {
                updated.push({ speaker: seg.speaker, text: seg.text, timestamp: Date.now() });
              }
            });
            return updated;
          })();

          // Update reactive total (drives stats, button enable, banner)
          setTotalSegments(allMessagesRef.current.length);

          // ── Keep React state capped at RENDER_WINDOW for performance ─
          // A 1-hour meeting can produce 1000+ segments. Letting React
          // re-render all of them on every new word causes UI freezes.
          // We always show the MOST RECENT segments so the user sees
          // the live transcript. Older segments are safe in allMessagesRef.
          setMessages(allMessagesRef.current.slice(-RENDER_WINDOW));
        } else if (data.message === 'AddPartialTranscript') {
          const words = data.results
            .map((r: any) => r.alternatives?.[0]?.content)
            .filter(Boolean)
            .join(' ');
          setPartialText(words);
        } else if (data.message === 'RecognitionStarted') {
          setIsRecording(true);
          isRecordingRef.current = true;
          setStatus('Live');
          startAutoSave(mid); // begin periodic segment persistence
        } else if (data.message === 'Error') {
          setStatus('Error');
          stopRecording();
        }
      });

      await clientRef.current.start(smJwt!, {
        transcription_config: {
          language: 'bn',
          operating_point: 'standard',
          diarization: 'speaker',
          speaker_diarization_config: { max_speakers: 5 },
          punctuation_overrides: { permitted_marks: ['.', '?', '!', ','] },
          enable_partials: true,
          max_delay_mode: 'flexible',
          enable_entities: true,
          max_delay: 1,
        },
        // Raw 32-bit float PCM — must match AudioContext sampleRate exactly (48000)
        audio_format: {
          type: 'raw',
          encoding: 'pcm_f32le',
          sample_rate: 48000, // fixed to match AudioContext({ sampleRate: 48000 }) above
        },
      });

      // ── 6. Load the AudioWorklet ───────────────────────────────
      //   Served from /public so Vite doesn't bundle/transform it;
      //   AudioWorklet requires its own JS execution scope.
      await audioContextRef.current.audioWorklet.addModule(
        '/audio-capture-processor.js'
      );

      // ── 7. Wire up capture graph ───────────────────────────────
      //   source → worklet → silentGain → destination
      //
      //   WHY connect to destination via a silent GainNode?
      //   Chrome's audio graph optimizer prunes sub-graphs that have no
      //   path to the destination. A dead-end (source → worklet, nothing
      //   after) causes Chrome to intermittently stop calling process(),
      //   creating the silent gaps / missing words the user experiences.
      //   Setting gain=0 means NO mic monitoring sound; the graph just
      //   needs a live path to the destination to stay active.
      const source     = audioContextRef.current.createMediaStreamSource(stream);
      const silentGain = audioContextRef.current.createGain();
      silentGain.gain.value = 0; // silent — user cannot hear themselves

      processorRef.current = new AudioWorkletNode(
        audioContextRef.current,
        'audio-capture-processor',
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
        }
      );

      // Receive batched Float32 PCM buffers from the worklet thread
      processorRef.current.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (clientRef.current && isRecordingRef.current) {
          clientRef.current.sendAudio(e.data);
        }
      };

      // Full live path: source → worklet → silentGain → destination
      source.connect(processorRef.current);
      processorRef.current.connect(silentGain);
      silentGain.connect(audioContextRef.current.destination);

    } catch (err: any) {
      console.error('[BanglaMeet] startRecording error:', err);
      setStatus(
        err?.name === 'NotAllowedError' ? 'Mic Denied' :
        err?.name === 'NotFoundError'   ? 'No Mic Found' :
        'Start Error'
      );
    }
  };

  const stopRecording = async () => {
    // Flip flags first so the worklet onmessage stops feeding Speechmatics
    setIsRecording(false);
    isRecordingRef.current = false;
    setStatus('Saving…');
    setPartialText('');

    // Stop periodic auto-save — we'll do a final save below
    stopAutoSave();

    // Flush the worklet's partial buffer before teardown
    processorRef.current?.port.postMessage({ type: 'flush' });
    await new Promise(r => setTimeout(r, 120));

    // Tear down Speechmatics
    try { clientRef.current?.stopRecognition(); } catch { /* ignore */ }

    // Disconnect audio graph and release mic
    try { processorRef.current?.disconnect(); } catch { /* ignore */ }
    try { await audioContextRef.current?.close(); } catch { /* ignore */ }
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;

    // ── Final save ──────────────────────────────────────────────────
    // allMessagesRef holds the FULL transcript regardless of RENDER_WINDOW.
    // savedSegCountRef tracks how many were already persisted by auto-save.
    // We only upload the TAIL (new segments since the last auto-save).
    const savedMid   = meetingIdRef.current;
    const savedTitle = meetingTitleRef.current;

    if (savedMid) {
      const duration  = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const allSegs   = allMessagesRef.current;
      const from      = savedSegCountRef.current;
      const newSegs   = allSegs.slice(from); // only un-persisted segments

      try {
        await api.patch(`/api/meetings/${savedMid}`, {
          status: 'completed',
          ended_at: Date.now(),
          duration_s: duration,
          title: savedTitle,
        });

        if (newSegs.length > 0) {
          await api.post(`/api/meetings/${savedMid}/segments`, {
            segments: newSegs.map(m => ({ speaker: m.speaker, text: m.text, timestamp: m.timestamp })),
          });
          savedSegCountRef.current = allSegs.length;
        }

        const totalSaved = allSegs.length;
        showToast(
          totalSaved > 0
            ? `Meeting saved — ${totalSaved} segments`
            : 'Meeting saved (no transcript)',
          'ok'
        );
      } catch {
        showToast('Failed to finalize meeting save', 'err');
      }
    }

    setStatus('Stopped');
  };


  const summarizeConversation = async () => {
    const allMsgs = allMessagesRef.current;
    if (!allMsgs.length) return;
    setIsSummarizing(true);
    setStatus('Analyzing…');
    try {
      // Use FULL transcript from ref (not capped state) for accurate summary
      const res = await api.post('/api/summarize', {
        transcript: allMsgs.map(m => `${m.speaker}: ${m.text}`).join('\n'),
        meeting_id: meetingId,
      });
      setSummary(res.data.summary);
      setShowSummary(true);
      setStatus('Complete');
    } catch {
      setStatus('Analysis Error');
    } finally {
      setIsSummarizing(false);
    }
  };

  const exportToPDF = async () => {
    if (!summary) return;
    const res = await api.post('/api/export-pdf', {
      summary,
      title: meetingTitle,
      meeting_id: meetingId,
    }, { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([res.data]));
    const a   = document.createElement('a');
    a.href = url;
    a.download = `${meetingTitle}-${Date.now()}.pdf`;
    a.click(); a.remove();
  };

  const saveNote = async () => {
    if (!noteText.trim() || !meetingId) return;
    try {
      const res = await api.post(`/api/meetings/${meetingId}/notes`, { content: noteText });
      setNotes(n => [res.data.note, ...n]);
      setNoteText('');
      showToast('Note saved', 'ok');
    } catch {
      showToast('Failed to save note', 'err');
    }
  };

  // Derive speakers from the full transcript ref (safe — uniqueSpeakers
  // only recomputes when messages state changes, which happens on every batch).
  // Per-speaker counts done inline in JSX via allMessagesRef.current.filter().
  const uniqueSpeakers = [...new Set(allMessagesRef.current.map(m => m.speaker))];
  const hiddenCount    = Math.max(0, totalSegments - messages.length);

  const statusClass =
    status === 'Live'    ? 'status-badge active'
    : (status.includes('Error') || status.includes('Denied') || status.includes('No Mic') || status === 'Start Error')
      ? 'status-badge error'
    : 'status-badge';

  return (
    <div className="meeting-page">
      {/* ── Meeting Header ─────────────────────────────────────── */}
      <div className="meeting-page-header">
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          {editingTitle ? (
            <input
              className="form-input title-input"
              value={meetingTitle}
              autoFocus
              onChange={e => setMeetingTitle(e.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={e => e.key === 'Enter' && setEditingTitle(false)}
            />
          ) : (
            <button
              className="meeting-title-btn"
              onClick={() => !isRecording && setEditingTitle(true)}
              disabled={isRecording}
            >
              <h1 className="meeting-title">{meetingTitle}</h1>
              {!isRecording && <PenLine size={13} style={{ opacity:0.4 }} />}
            </button>
          )}
          <div className={statusClass}>
            {status === 'Live' && <div className="pulse-dot" />}
            {status}
          </div>
        </div>
        {isRecording && (
          <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, fontWeight:700, color:'var(--danger)', fontVariantNumeric:'tabular-nums' }}>
            <div className="pulse-dot" style={{ background:'var(--danger)' }} />
            {formatElapsed(elapsed)}
          </div>
        )}
      </div>

      <div className="meeting-layout">
        {/* Left — Transcript */}
        <section className="transcript-section">
          <div className="transcript-header">
            <div className="transcript-title">
              <FileText size={13} strokeWidth={2.5} />
              Live Transcript
            </div>
            {totalSegments > 0 && (
              <span className="transcript-count">{totalSegments} segments</span>
            )}
          </div>

          <div className="transcript-viewport" ref={scrollRef}>
            {/* Banner shown when older segments are scrolled off (80-item window) */}
            {hiddenCount > 0 && (
              <div style={{
                padding: '8px 14px',
                margin: '0 0 8px 0',
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                color: 'var(--accent)',
                fontWeight: 600,
                textAlign: 'center',
                flexShrink: 0,
              }}>
                ↑ {hiddenCount} earlier segments — showing most recent {messages.length}
              </div>
            )}
            {messages.length === 0 && !partialText && (
              <div className="empty-state">
                <div className="empty-icon">
                  <Waves size={30} strokeWidth={1.5} color="var(--text-3)" />
                </div>
                <h3>Ready to listen</h3>
                <p>Press <strong>Start Session</strong> and BanglaMeet will transcribe your conversation in real-time.</p>
              </div>
            )}

            {messages.map((msg, idx) => (
              <motion.div
                key={idx}
                className="message-node"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                <div className="speaker-avatar" data-speaker={msg.speaker}>
                  {msg.speaker}
                </div>
                <div className="message-body">
                  <div className="speaker-header">
                    <span className="speaker-name" data-speaker={msg.speaker}
                      style={{ color: getSpeakerColor(msg.speaker) }}>
                      Speaker {msg.speaker}
                    </span>
                    <span className="msg-time">{formatTime(msg.timestamp)}</span>
                  </div>
                  <div className="content-bubble">{msg.text}</div>
                </div>
              </motion.div>
            ))}

            {partialText && (
              <motion.div className="message-node partial" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="speaker-avatar" style={{ background:'var(--accent-soft)', border:'1px solid var(--border)' }}>
                  <Radio size={14} strokeWidth={2} color="var(--accent)" />
                </div>
                <div className="message-body">
                  <div className="speaker-header">
                    <span className="speaker-name" style={{ color: 'var(--accent)' }}>Transcribing</span>
                    <span className="typing-indicator">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </span>
                  </div>
                  <div className="content-bubble">{partialText}</div>
                </div>
              </motion.div>
            )}
          </div>
        </section>

        {/* Right — Sidebar */}
        <aside className="sidebar-controls">
          {/* Session control */}
          <div className="sidebar-section">
            <div className="section-label">Session</div>
            {!isRecording ? (
              <button className="action-btn btn-primary" onClick={startRecording} id="start-session-btn">
                <Mic size={16} strokeWidth={2.5} /> Start Session
              </button>
            ) : (
              <button className="action-btn btn-danger" onClick={stopRecording} id="stop-session-btn">
                <Square size={15} strokeWidth={2.5} /> Stop & Save
              </button>
            )}
          </div>

          {/* Live viz */}
          <AnimatePresence>
            {isRecording && (
              <motion.div
                className="sidebar-section"
                initial={{ opacity:0, height:0, overflow:'hidden' }}
                animate={{ opacity:1, height:'auto', overflow:'visible' }}
                exit={{ opacity:0, height:0, overflow:'hidden' }}
                transition={{ duration:0.25 }}
              >
                <div className="section-label">Audio Input</div>
                <div className="audio-visualizer-card">
                  <div className="visualizer-label">
                    <div className="live-badge"><div className="pulse-dot" />Recording</div>
                    <span style={{ fontSize:13, fontWeight:700, color:'var(--text)', fontVariantNumeric:'tabular-nums', letterSpacing:'-0.02em' }}>
                      {formatElapsed(elapsed)}
                    </span>
                  </div>
                  <div className="audio-visual">
                    {[...Array(18)].map((_, i) => (
                      <motion.div
                        key={i}
                        className="bar-item"
                        animate={{ height: [3, Math.random() * 36 + 6, 3] }}
                        transition={{ repeat:Infinity, duration:0.45 + Math.random() * 0.3, delay: i * 0.04, ease:'easeInOut' }}
                      />
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Stats */}
          <div className="sidebar-section">
            <div className="section-label">Overview</div>
            <div className="stats-row">
              <div className="stat-card">
                <div className="stat-value">{totalSegments}</div>
                <div className="stat-label">Segments</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{uniqueSpeakers.length}</div>
                <div className="stat-label">Speakers</div>
              </div>
            </div>
          </div>

          {/* Speakers */}
          {uniqueSpeakers.length > 0 && (
            <div className="sidebar-section">
              <div className="section-label"><Users size={10} />Participants</div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {uniqueSpeakers.map(sp => (
                  <div key={sp} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 12px', background:'var(--panel-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', fontSize:13, fontWeight:600 }}>
                    <div style={{ width:7, height:7, borderRadius:'50%', background:getSpeakerColor(sp), flexShrink:0, boxShadow:`0 0 6px ${getSpeakerColor(sp)}` }} />
                    <span style={{ color:'var(--text)' }}>Speaker {sp}</span>
                    <span style={{ marginLeft:'auto', color:'var(--text-3)', fontSize:11.5, fontWeight:500 }}>
                      {allMessagesRef.current.filter(m => m.speaker === sp).length} seg
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes (visible when meetingId exists) */}
          {meetingId && (
            <div className="sidebar-section">
              <div className="section-label"><PenLine size={10} />Quick Notes</div>
              <div style={{ display:'flex', gap:8 }}>
                <input
                  className="form-input"
                  placeholder="Add note…"
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveNote()}
                  style={{ flex:1, height:38 }}
                />
                <button className="btn-icon" onClick={saveNote} disabled={!noteText.trim()} style={{ width:38, height:38, flexShrink:0 }}>
                  <Save size={14} />
                </button>
              </div>
              {notes.length > 0 && (
                <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:8 }}>
                  {notes.slice(0, 3).map(n => (
                    <div key={n.id} className="note-card" style={{ padding:'8px 12px' }}>
                      <p style={{ fontSize:12.5, lineHeight:1.5, color:'var(--text)' }}>{n.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* AI Analysis */}
          <div className="sidebar-section">
            <div className="section-label"><Zap size={10} />AI Analysis</div>
            <button
              className="action-btn btn-outline"
              onClick={summarizeConversation}
              disabled={isRecording || totalSegments === 0 || isSummarizing}
              id="generate-summary-btn"
            >
              {isSummarizing ? <Activity size={15} className="animate-spin" /> : <Sparkles size={15} strokeWidth={2.2} />}
              {isSummarizing ? 'Analyzing…' : 'Generate Summary'}
              {!isSummarizing && totalSegments > 0 && <ChevronRight size={13} style={{ marginLeft:'auto', opacity:0.5 }} />}
            </button>
          </div>

          {/* Footer */}
          <div className="sidebar-footer">
            <div className="info-chip">
              <Settings size={13} strokeWidth={2} color="var(--text-3)" />
              <div className="info-chip-detail">
                <strong>Bangla STT</strong>
                <span style={{ fontSize:11.5, color:'var(--text-3)' }}>Speechmatics · Diarization</span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Summary Modal ─────────────────────────────────────── */}
      <AnimatePresence>
        {showSummary && (
          <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowSummary(false); }}>
            <motion.div
              className="modal-box"
              initial={{ opacity:0, scale:0.96, y:12 }}
              animate={{ opacity:1, scale:1, y:0 }}
              exit={{ opacity:0, scale:0.96, y:12 }}
              transition={{ duration:0.22, ease:[0.4,0,0.2,1] }}
            >
              <div className="modal-header">
                <div className="modal-title-group">
                  <div className="modal-title-icon"><Sparkles size={17} strokeWidth={2.2} /></div>
                  <div>
                    <h2>Meeting Insights</h2>
                    <p>AI-generated summary</p>
                  </div>
                </div>
                <button className="btn-icon" onClick={() => setShowSummary(false)}><X size={16} /></button>
              </div>
              <div className="modal-body">
                <div className="summary-content">{summary}</div>
              </div>
              <div className="modal-footer">
                <button
                  className="btn-icon"
                  onClick={() => setShowSummary(false)}
                  style={{ width:'auto', padding:'0 18px', borderRadius:'var(--radius-md)', fontSize:'13.5px', fontWeight:600, height:40, display:'flex', alignItems:'center' }}
                >
                  Close
                </button>
                <button
                  className="action-btn btn-primary"
                  onClick={exportToPDF}
                  style={{ width:'auto', padding:'0 22px', height:40 }}
                  id="export-pdf-btn"
                >
                  <Download size={15} strokeWidth={2.5} /> Export PDF
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Toast ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            className={`toast toast-${toast.type}`}
            initial={{ opacity:0, y:16, scale:0.95 }}
            animate={{ opacity:1, y:0, scale:1 }}
            exit={{ opacity:0, y:16, scale:0.95 }}
            transition={{ duration:0.18 }}
          >
            {toast.type === 'ok'
              ? <CheckCircle2 size={15} />
              : <AlertTriangle size={15} />
            }
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
