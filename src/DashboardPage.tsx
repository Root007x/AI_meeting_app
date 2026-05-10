import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Mic, BarChart2, FileText, Users, Clock, TrendingUp, Calendar, Zap } from 'lucide-react';
import api from './api';
import { useAuth } from './AuthContext';

interface Stats {
  totalMeetings: number;
  totalSegments: number;
  totalDuration: number;
  totalSummaries: number;
  recentActivity: { day: string; count: number }[];
}

function StatCard({ icon, label, value, color, delay }: {
  icon: React.ReactNode; label: string; value: string | number;
  color: string; delay: number;
}) {
  return (
    <motion.div
      className="dash-stat-card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      style={{ borderTop: `2px solid ${color}` }}
    >
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <div className="stat-value" style={{ fontSize: 32, color }}>{value}</div>
        <div style={{ color, opacity: 0.5 }}>{icon}</div>
      </div>
      <div className="stat-label" style={{ marginTop: 8 }}>{label}</div>
    </motion.div>
  );
}

function ActivityBar({ day, count, max }: { day: string; count: number; max: number }) {
  const height = max > 0 ? Math.max((count / max) * 100, 8) : 8;
  return (
    <div className="activity-bar-wrap">
      <div style={{ position:'relative', height:80, display:'flex', alignItems:'flex-end' }}>
        <motion.div
          className="activity-bar"
          initial={{ height: 0 }}
          animate={{ height: `${height}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          title={`${count} meeting(s)`}
        />
      </div>
      <div className="activity-bar-label">
        {new Date(day + 'T00:00:00').toLocaleDateString('en', { weekday:'short' })}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [stats, setStats]     = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [recentMeetings, setRecentMeetings] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      api.get('/api/stats'),
      api.get('/api/meetings', { params: { limit: 5 } }),
    ]).then(([statsRes, meetingsRes]) => {
      setStats(statsRes.data);
      setRecentMeetings(meetingsRes.data.meetings);
    }).finally(() => setLoading(false));
  }, []);

  function formatDuration(s: number) {
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  const maxActivity = Math.max(...(stats?.recentActivity?.map(r => r.count) || [1]));

  // Fill last 7 days
  const last7: { day: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const found = stats?.recentActivity?.find(r => r.day === key);
    last7.push({ day: key, count: found?.count || 0 });
  }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', flex:1, color:'var(--text-3)' }}>
      <div className="animate-spin" style={{ width:32, height:32, border:'2px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%' }} />
    </div>
  );

  return (
    <div className="dashboard-page">
      {/* Welcome */}
      <motion.div
        className="dash-welcome"
        initial={{ opacity:0, y:-8 }}
        animate={{ opacity:1, y:0 }}
        transition={{ duration:0.3 }}
      >
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <img
            src={user?.avatar}
            alt={user?.name}
            style={{ width:48, height:48, borderRadius:14, border:'1px solid var(--border)' }}
          />
          <div>
            <div style={{ fontSize:20, fontWeight:800, letterSpacing:'-0.03em' }}>
              Welcome back, {user?.name?.split(' ')[0]} 👋
            </div>
            <div style={{ fontSize:13, color:'var(--text-2)', marginTop:2 }}>
              {new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Stat cards */}
      <div className="dash-stats-grid">
        <StatCard icon={<Mic size={20}/>}       label="Total Meetings"  value={stats?.totalMeetings  || 0} color="var(--accent)"  delay={0.05} />
        <StatCard icon={<FileText size={20}/>}  label="AI Summaries"   value={stats?.totalSummaries || 0} color="var(--success)" delay={0.10} />
        <StatCard icon={<Users size={20}/>}     label="Transcript Seg." value={stats?.totalSegments  || 0} color="var(--warning)" delay={0.15} />
        <StatCard icon={<Clock size={20}/>}     label="Total Recorded"  value={formatDuration(stats?.totalDuration || 0)} color="var(--accent-2)" delay={0.20} />
      </div>

      <div className="dash-bottom-grid">
        {/* Activity chart */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, fontSize:14 }}>
              <TrendingUp size={15} color="var(--accent)" /> Activity — Last 7 Days
            </div>
          </div>
          <div className="dash-panel-body">
            {last7.every(d => d.count === 0) ? (
              <div style={{ textAlign:'center', color:'var(--text-3)', padding:24 }}>
                <BarChart2 size={28} style={{ margin:'0 auto 8px', opacity:0.3 }} />
                <p style={{ fontSize:13 }}>No meetings this week</p>
              </div>
            ) : (
              <div className="activity-chart">
                {last7.map(d => (
                  <ActivityBar key={d.day} day={d.day} count={d.count} max={maxActivity} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent meetings */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:700, fontSize:14 }}>
              <Calendar size={15} color="var(--accent)" /> Recent Meetings
            </div>
          </div>
          <div className="dash-panel-body" style={{ padding:0 }}>
            {recentMeetings.length === 0 ? (
              <div style={{ textAlign:'center', color:'var(--text-3)', padding:24 }}>
                <Mic size={24} style={{ margin:'0 auto 8px', opacity:0.3 }} />
                <p style={{ fontSize:13 }}>No meetings recorded yet</p>
              </div>
            ) : recentMeetings.map((m, i) => (
              <motion.div
                key={m.id}
                className="recent-meeting-row"
                initial={{ opacity:0, x:8 }}
                animate={{ opacity:1, x:0 }}
                transition={{ delay: i * 0.05 }}
              >
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div className="recent-meeting-icon">
                    <Mic size={13} />
                  </div>
                  <div>
                    <div style={{ fontSize:13.5, fontWeight:600 }}>{m.title}</div>
                    <div style={{ fontSize:11.5, color:'var(--text-3)', marginTop:2 }}>
                      {new Date(m.started_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}
                      {' · '}{m.speaker_count} speakers · {m.segment_count} seg
                    </div>
                  </div>
                </div>
                {m.summary_preview && (
                  <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <Zap size={11} color="var(--success)" />
                    <span style={{ fontSize:11, color:'var(--success)', fontWeight:600 }}>Summary</span>
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
