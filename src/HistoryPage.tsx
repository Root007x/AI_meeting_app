import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Calendar, Clock, Users, FileText, Trash2,
  ChevronRight, Mic, Tag, X, MessageSquare, Download,
  SortDesc, RefreshCw, Eye, Activity, Sparkles, Zap
} from 'lucide-react';
import api from './api';

interface Meeting {
  id: string;
  title: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_s: number | null;
  segment_count: number;
  speaker_count: number;
  summary_preview: string | null;
  tags: string | null;
}

interface MeetingDetailProps {
  id: string;
  onClose: () => void;
}

function MeetingDetail({ id, onClose }: MeetingDetailProps) {
  const [data, setData]       = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote]       = useState('');
  const [saving, setSaving]   = useState(false);
  const [newTag, setNewTag]   = useState('');
  const [isSummarizing, setIsSummarizing] = useState(false);

  useEffect(() => {
    api.get(`/api/meetings/${id}`)
      .then(r => setData(r.data))
      .finally(() => setLoading(false));
  }, [id]);

  const addNote = async () => {
    if (!note.trim()) return;
    setSaving(true);
    const res = await api.post(`/api/meetings/${id}/notes`, { content: note });
    setData((d: any) => ({ ...d, notes: [res.data.note, ...d.notes] }));
    setNote('');
    setSaving(false);
  };

  const deleteNote = async (noteId: number) => {
    await api.delete(`/api/notes/${noteId}`);
    setData((d: any) => ({ ...d, notes: d.notes.filter((n: any) => n.id !== noteId) }));
  };

  const addTag = async () => {
    if (!newTag.trim()) return;
    const currentTags = data?.tags || [];
    const updated = [...currentTags, newTag.trim()];
    await api.patch(`/api/meetings/${id}`, { tags: updated });
    setData((d: any) => ({ ...d, tags: updated }));
    setNewTag('');
  };

  const removeTag = async (tag: string) => {
    const updated = (data?.tags || []).filter((t: string) => t !== tag);
    await api.patch(`/api/meetings/${id}`, { tags: updated });
    setData((d: any) => ({ ...d, tags: updated }));
  };

  const generateSummary = async () => {
    if (!data?.segments?.length) return;
    setIsSummarizing(true);
    try {
      const res = await api.post('/api/summarize', {
        transcript: data.segments.map((s: any) => `${s.speaker}: ${s.text}`).join('\n'),
        meeting_id: id,
      });
      setData((d: any) => ({ 
        ...d, 
        summary: res.data.summary, 
        meeting: { ...d.meeting, summary_preview: res.data.summary.substring(0, 100) } 
      }));
    } catch (err) {
      console.error('Failed to generate summary', err);
      alert('Failed to generate summary');
    } finally {
      setIsSummarizing(false);
    }
  };

  const exportPDF = async () => {
    if (!data?.summary) return;
    const res = await api.post('/api/export-pdf', {
      summary: data.summary,
      title: data.meeting.title,
      meeting_id: id
    }, { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([res.data]));
    const a = document.createElement('a');
    a.href = url; a.download = `${data.meeting.title}-summary.pdf`; a.click();
    a.remove();
  };

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:300 }}>
      <div className="animate-spin" style={{ width:32, height:32, border:'2px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%' }} />
    </div>
  );

  const segments = data?.segments || [];
  const notes    = data?.notes    || [];
  const tags     = data?.tags     || [];
  const meeting  = data?.meeting;

  return (
    <div className="detail-modal-content">
      <div className="detail-header">
        <div>
          <h2 style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.03em' }}>{meeting?.title}</h2>
          <div style={{ display:'flex', gap:16, marginTop:6, fontSize:12, color:'var(--text-2)' }}>
            <span style={{ display:'flex', alignItems:'center', gap:5 }}>
              <Calendar size={12} />{new Date(meeting?.started_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}
            </span>
            <span style={{ display:'flex', alignItems:'center', gap:5 }}>
              <MessageSquare size={12} />{segments.length} segments
            </span>
            <span style={{ display:'flex', alignItems:'center', gap:5 }}>
              <Users size={12} />{[...new Set(segments.map((s: any) => s.speaker))].length} speakers
            </span>
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {data?.summary && (
            <button className="btn-icon" onClick={exportPDF} title="Export PDF" style={{ width:38, height:38 }}>
              <Download size={15} />
            </button>
          )}
          <button className="btn-icon" onClick={onClose} style={{ width:38, height:38 }}>
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Tags */}
      <div style={{ padding:'16px 28px', borderBottom:'1px solid var(--border)', display:'flex', flexWrap:'wrap', gap:8, alignItems:'center' }}>
        {tags.map((t: string) => (
          <span key={t} className="tag-chip">
            {t}
            <button onClick={() => removeTag(t)} style={{ background:'none', border:'none', cursor:'pointer', color:'inherit', padding:'0 0 0 4px', display:'flex' }}>
              <X size={10} />
            </button>
          </span>
        ))}
        <div style={{ display:'flex', gap:6 }}>
          <input
            className="form-input tag-input"
            placeholder="Add tag…"
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTag()}
          />
          {newTag && (
            <button className="btn-icon" onClick={addTag} style={{ width:32, height:32 }}>
              <ChevronRight size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="detail-body">
        {/* Summary */}
        {data?.summary ? (
          <div className="detail-section">
            <div className="section-label"><FileText size={10} /> AI Summary</div>
            <div className="summary-box">{data.summary}</div>
          </div>
        ) : (
          <div className="detail-section">
            <div className="section-label"><Zap size={10} /> AI Summary</div>
            <div style={{ background: 'var(--panel-2)', padding: 16, borderRadius: 'var(--radius)', border: '1px solid var(--border)', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>No summary was generated for this meeting.</p>
              <button
                className="action-btn btn-outline"
                style={{ margin: '0 auto', width: 'auto', padding: '0 16px' }}
                onClick={generateSummary}
                disabled={isSummarizing || segments.length === 0}
              >
                {isSummarizing ? <Activity size={15} className="animate-spin" /> : <Sparkles size={15} strokeWidth={2.2} />}
                {isSummarizing ? 'Analyzing…' : 'Generate Summary'}
              </button>
            </div>
          </div>
        )}

        {/* Transcript */}
        <div className="detail-section">
          <div className="section-label"><Mic size={10} /> Transcript</div>
          <div className="transcript-scroll">
            {segments.length === 0 ? (
              <p style={{ color:'var(--text-3)', fontSize:13 }}>No transcript segments saved.</p>
            ) : segments.map((s: any, i: number) => (
              <div key={i} className="history-segment">
                <span className={`seg-speaker seg-speaker-${s.speaker}`}>{s.speaker}</span>
                <span style={{ fontSize:14, color:'var(--text)', lineHeight:1.6 }}>{s.text}</span>
                <span style={{ fontSize:11, color:'var(--text-3)', marginLeft:'auto', whiteSpace:'nowrap' }}>
                  {new Date(s.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div className="detail-section">
          <div className="section-label"><MessageSquare size={10} /> Meeting Notes</div>
          <div className="notes-input-row">
            <textarea
              className="notes-textarea"
              placeholder="Add a note about this meeting…"
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
            />
            <button
              className="action-btn btn-primary"
              onClick={addNote}
              disabled={!note.trim() || saving}
              style={{ width:'auto', padding:'0 20px', height:40, flexShrink:0 }}
            >
              {saving ? '…' : 'Save'}
            </button>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:12 }}>
            {notes.map((n: any) => (
              <div key={n.id} className="note-card">
                <p style={{ fontSize:13.5, lineHeight:1.6, color:'var(--text)' }}>{n.content}</p>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:8 }}>
                  <span style={{ fontSize:11, color:'var(--text-3)' }}>
                    {new Date(n.created_at * 1000).toLocaleString()}
                  </span>
                  <button className="btn-icon" onClick={() => deleteNote(n.id)} style={{ width:26, height:26, borderRadius:6 }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════ */

export default function HistoryPage() {
  const [meetings, setMeetings]   = useState<Meeting[]>([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [query, setQuery]         = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting]   = useState<string | null>(null);

  const fetchMeetings = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const res = await api.get('/api/meetings', { params: { q, limit: 50 } });
      setMeetings(res.data.meetings);
      setTotal(res.data.total);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery(search);
    fetchMeetings(search);
  };

  const deleteMeeting = async (id: string) => {
    if (!confirm('Delete this meeting and all its data?')) return;
    setDeleting(id);
    await api.delete(`/api/meetings/${id}`);
    setMeetings(m => m.filter(x => x.id !== id));
    setDeleting(null);
    if (selectedId === id) setSelectedId(null);
  };

  function formatDuration(s: number | null) {
    if (!s) return '—';
    const m = Math.floor(s / 60), sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  function relativeDate(ts: number) {
    const diff = Date.now() - ts;
    const d = Math.floor(diff / 86400000);
    if (d === 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 7)  return `${d} days ago`;
    return new Date(ts).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  }

  return (
    <div className="history-page">
      {/* Left: meeting list */}
      <div className="history-list-panel">
        <div className="history-list-header">
          <div>
            <h1 style={{ fontSize:18, fontWeight:800, letterSpacing:'-0.03em' }}>Meeting History</h1>
            <p style={{ fontSize:12.5, color:'var(--text-2)', marginTop:2 }}>{total} total meetings</p>
          </div>
          <button className="btn-icon" onClick={() => fetchMeetings(query)} title="Refresh" style={{ width:36, height:36 }}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Search */}
        <form onSubmit={doSearch} className="history-search">
          <Search size={14} className="input-icon" style={{ left:12, top:'50%', transform:'translateY(-50%)' }} />
          <input
            className="form-input"
            style={{ paddingLeft:36 }}
            placeholder="Search meetings…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </form>

        {/* List */}
        <div className="history-list">
          {loading && meetings.length === 0 ? (
            <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>
              <div className="animate-spin" style={{ width:24, height:24, border:'2px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%', margin:'0 auto 12px' }} />
              Loading…
            </div>
          ) : meetings.length === 0 ? (
            <div style={{ padding:40, textAlign:'center', color:'var(--text-3)' }}>
              <Calendar size={32} style={{ margin:'0 auto 12px', opacity:0.3 }} />
              <p style={{ fontWeight:600, fontSize:14, color:'var(--text-2)' }}>No meetings yet</p>
              <p style={{ fontSize:12.5, marginTop:4 }}>Start a session to see your history here.</p>
            </div>
          ) : meetings.map(m => (
            <motion.div
              key={m.id}
              className={`history-item ${selectedId === m.id ? 'active' : ''}`}
              onClick={() => setSelectedId(m.id)}
              initial={{ opacity:0, x:-8 }}
              animate={{ opacity:1, x:0 }}
              transition={{ duration:0.2 }}
            >
              <div className="history-item-top">
                <span className="history-item-title">{m.title}</span>
                <button
                  className="btn-icon"
                  style={{ width:26, height:26, borderRadius:6, opacity: deleting === m.id ? 0.5 : 1 }}
                  onClick={e => { e.stopPropagation(); deleteMeeting(m.id); }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="history-item-meta">
                <span>{relativeDate(m.started_at)}</span>
                <span>·</span>
                <span>{formatDuration(m.duration_s)}</span>
                <span>·</span>
                <span>{m.speaker_count} spk</span>
                <span>·</span>
                <span>{m.segment_count} seg</span>
              </div>
              {m.tags && (
                <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:6 }}>
                  {m.tags.split(',').map(t => (
                    <span key={t} className="tag-chip" style={{ fontSize:10, padding:'2px 7px' }}>{t}</span>
                  ))}
                </div>
              )}
              {selectedId === m.id && (
                <div style={{ display:'flex', alignItems:'center', gap:4, marginTop:6, fontSize:11.5, color:'var(--accent)', fontWeight:600 }}>
                  <Eye size={11} /> Viewing details →
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>

      {/* Right: meeting detail */}
      <div className="history-detail-panel">
        <AnimatePresence mode="wait">
          {selectedId ? (
            <motion.div
              key={selectedId}
              initial={{ opacity:0, x:16 }}
              animate={{ opacity:1, x:0 }}
              exit={{ opacity:0, x:16 }}
              transition={{ duration:0.22 }}
              style={{ height:'100%', overflow:'auto' }}
            >
              <MeetingDetail id={selectedId} onClose={() => setSelectedId(null)} />
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              className="empty-state"
              initial={{ opacity:0 }}
              animate={{ opacity:1 }}
              style={{ height:'100%' }}
            >
              <div className="empty-icon">
                <FileText size={28} strokeWidth={1.5} color="var(--text-3)" />
              </div>
              <h3>Select a meeting</h3>
              <p>Choose a meeting from the list to view its transcript, summary, and notes.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
