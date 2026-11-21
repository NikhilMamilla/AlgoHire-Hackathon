import { NavLink, Route, Routes } from 'react-router-dom';
import Home from './pages/Home';

export default function App() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">CertiFlow</div>
        <nav>
          <NavLink to="/" end className="nav-link">Home</NavLink>
        </nav>
      </aside>
      <header className="topbar">
        <span className="topbar-title">Skilling certificate issuance</span>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
