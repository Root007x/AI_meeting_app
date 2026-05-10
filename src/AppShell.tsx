import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BrainCircuit, LayoutDashboard, History, Mic, Search, LogOut, ChevronDown, X, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from './AuthContext';
import api from './api';

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearch, setShowSearch]     = useState(false);
  const [searching, setSearching]       = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const doSearch = async (q: string) => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const res = await api.get('/api/search', { params: { q } });
      setSearchResults(res.data.results);
    } finally {
      setSearching(false);
    }
  };

  const navItems = [
    { to: '/',         icon: <LayoutDashboard size={17} strokeWidth={2} />, label: 'Dashboard' },
    { to: '/meeting',  icon: <Mic size={17} strokeWidth={2} />,             label: 'Live Meeting' },
    { to: '/history',  icon: <History size={17} strokeWidth={2} />,         label: 'History' },
  ];

  return (
    <div className="app-shell">
      {/* ── Sidebar Nav ─────────────────────────────────────────── */}
      <nav className="app-nav">
        <div className="nav-logo">
          <div className="logo-icon" style={{ width:36, height:36, borderRadius:11 }}>
            <BrainCircuit size={19} color="var(--panel)" strokeWidth={2.2} />
          </div>
          <div>
            <div style={{ fontSize:14, fontWeight:800, letterSpacing:'-0.03em', lineHeight:1, color:'var(--text)' }}>
              BanglaMeet
            </div>
            <div style={{ fontSize:10, color:'var(--text-3)', letterSpacing:'0.06em', textTransform:'uppercase', fontWeight:700 }}>AI</div>
          </div>
        </div>

        {/* Search trigger */}
        <button className="nav-search-btn" onClick={() => setShowSearch(true)}>
          <Search size={14} />
          <span>Search transcripts…</span>
          <span className="nav-search-kbd">⌘K</span>
        </button>

        <div className="nav-items">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>

        {/* User section */}
        <div className="nav-user-section">
          <button
            className="nav-user-btn"
            onClick={() => setShowUserMenu(v => !v)}
          >
            <img
              src={user?.avatar}
              alt={user?.name}
              style={{ width:32, height:32, borderRadius:9, border:'1px solid var(--border)' }}
            />
            <div style={{ flex:1, textAlign:'left', minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:700, lineHeight:1.2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {user?.name}
              </div>
              <div style={{ fontSize:11, color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {user?.email}
              </div>
            </div>
            <ChevronDown size={14} color="var(--text-3)" style={{ flexShrink:0, transform: showUserMenu ? 'rotate(180deg)' : 'none', transition:'transform 0.2s' }} />
          </button>

          <AnimatePresence>
            {showUserMenu && (
              <motion.div
                className="user-menu"
                initial={{ opacity:0, y:8, scale:0.96 }}
                animate={{ opacity:1, y:0, scale:1 }}
                exit={{ opacity:0, y:8, scale:0.96 }}
                transition={{ duration:0.15 }}
              >
                <button className="user-menu-item danger" onClick={handleLogout}>
                  <LogOut size={14} /> Sign Out
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </nav>

      {/* ── Page Content ────────────────────────────────────────── */}
      <main className="app-main">
        <Outlet />
      </main>

      {/* ── Global Search Modal ──────────────────────────────────── */}
      <AnimatePresence>
        {showSearch && (
          <div className="modal-backdrop" onClick={() => setShowSearch(false)}>
            <motion.div
              className="search-modal"
              initial={{ opacity:0, scale:0.96, y:-12 }}
              animate={{ opacity:1, scale:1, y:0 }}
              exit={{ opacity:0, scale:0.96, y:-12 }}
              transition={{ duration:0.18 }}
              onClick={e => e.stopPropagation()}
            >
              <div className="search-modal-input-row">
                <Search size={17} color="var(--text-2)" />
                <input
                  autoFocus
                  className="search-modal-input"
                  placeholder="Search meeting transcripts…"
                  value={searchQuery}
                  onChange={e => doSearch(e.target.value)}
                />
                {searching && (
                  <div className="animate-spin" style={{ width:16, height:16, border:'2px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%', flexShrink:0 }} />
                )}
                <button className="btn-icon" onClick={() => setShowSearch(false)} style={{ width:30, height:30, borderRadius:7 }}>
                  <X size={14} />
                </button>
              </div>

              <div className="search-results">
                {searchResults.length === 0 && searchQuery && !searching && (
                  <div style={{ padding:'32px 24px', textAlign:'center', color:'var(--text-3)', fontSize:13 }}>
                    No results for "<strong>{searchQuery}</strong>"
                  </div>
                )}
                {!searchQuery && (
                  <div style={{ padding:'28px 24px', textAlign:'center', color:'var(--text-3)', fontSize:13 }}>
                    Type to search across all your meeting transcripts
                  </div>
                )}
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    className="search-result-item"
                    onClick={() => { navigate('/history'); setShowSearch(false); }}
                  >
                    <div style={{ fontSize:12, fontWeight:700, color:'var(--accent)', marginBottom:4 }}>
                      {r.title}
                      <span style={{ fontWeight:400, color:'var(--text-3)', marginLeft:8 }}>
                        <Clock size={10} style={{ display:'inline', marginRight:3 }} />
                        {new Date(r.started_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}
                      </span>
                    </div>
                    <div style={{ fontSize:13.5, color:'var(--text)', lineHeight:1.5 }}>
                      <span style={{ color:'var(--text-2)', fontSize:11, fontWeight:600, marginRight:6 }}>{r.speaker}</span>
                      {r.text}
                    </div>
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
