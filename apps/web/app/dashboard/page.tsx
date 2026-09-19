import Link from 'next/link';
import { fetchReadiness } from '../../lib/api/readiness';
import { readWebEnv } from '../../lib/env';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const env = readWebEnv();
  const health = await fetchReadiness(env.API_INTERNAL_URL);
  const ready = health?.status === 'ready';
  const connected = health !== null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Application">
        <Link
          className="brand"
          href="/dashboard"
          aria-label="Smart Printer Queue home"
        >
          <span className="brand-mark" aria-hidden="true">
            SQ
          </span>
          <span>
            Smart Printer
            <span className="brand-subtitle">QUEUE MANAGEMENT</span>
          </span>
        </Link>
        <div className="sidebar-section">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <Link
            className="nav-item active"
            href="/dashboard"
            aria-current="page"
          >
            <span aria-hidden="true">▦</span> Overview
          </Link>
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">OS SIMULATION</span>
          <p>Scheduling, synchronization, and recovery. Made observable.</p>
          <span className="mono">FOUNDATION / V1</span>
        </div>
        <div className="sidebar-footer">
          <span className="status-dot" aria-hidden="true" /> Simulated printers
          only
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <span className="topbar-title">
            Workspace <span aria-hidden="true">/</span>{' '}
            <strong>Overview</strong>
          </span>
          <span className="environment">{env.NEXT_PUBLIC_APP_ENV}</span>
        </header>

        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">SMART PRINTER QUEUE</p>
              <h1>System overview</h1>
              <p className="description">
                The deterministic core of an observable operating systems
                simulation.
              </p>
            </div>
            <span className="phase-badge">
              Week 02 <span aria-hidden="true">/</span> Domain engine
            </span>
          </div>

          <section
            className="connection-banner"
            aria-label="Connection status"
            role="status"
          >
            <span
              className={`status-dot ${connected ? 'connected' : 'disconnected'}`}
              aria-hidden="true"
            />
            <div>
              <strong>{connected ? 'API connected' : 'API unavailable'}</strong>
              <p>
                {connected
                  ? 'The web application can reach the API service.'
                  : 'The API could not be reached or returned an invalid health response. Start the API service and check again.'}
              </p>
            </div>
            <a className="check-button" href="/dashboard">
              Check again <span aria-hidden="true">↻</span>
            </a>
          </section>

          <div className="status-grid">
            <section
              className="panel readiness-panel"
              aria-labelledby="readiness-title"
            >
              <div className="panel-header">
                <h2 id="readiness-title">Service readiness</h2>
                <span className="mono panel-index">01</span>
              </div>
              <div className="readiness-summary">
                <span className="eyebrow">SIMULATION STATUS</span>
                <h3>
                  {ready
                    ? 'Ready to accept traffic'
                    : connected
                      ? 'Domain engine is proven'
                      : 'Waiting for the API'}
                </h3>
                <p>
                  {ready
                    ? 'All required service checks passed.'
                    : connected
                      ? 'Scheduling is ready; persistence and coordination arrive in the next phases.'
                      : 'Readiness will appear here when the connection is restored.'}
                </p>
              </div>
              <dl className="component-list">
                {health ? (
                  Object.entries(health.components).map(([name, status]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>
                        <span
                          className={`status-dot ${status === 'ready' ? 'connected' : ''}`}
                          aria-hidden="true"
                        />
                        {status === 'ready'
                          ? 'Ready'
                          : status === 'not_implemented'
                            ? 'Not built yet'
                            : 'Unavailable'}
                      </dd>
                    </div>
                  ))
                ) : (
                  <div>
                    <dt>Service checks</dt>
                    <dd>Unavailable</dd>
                  </div>
                )}
              </dl>
              <div className="panel-footer">
                {health ? (
                  <>
                    API version <span className="mono">{health.version}</span>
                  </>
                ) : (
                  'No health data available'
                )}
              </div>
            </section>

            <section className="panel" aria-labelledby="foundation-title">
              <div className="panel-header">
                <h2 id="foundation-title">A shared foundation</h2>
                <span className="mono panel-index">02</span>
              </div>
              <div className="foundation-content">
                <span className="foundation-symbol" aria-hidden="true">
                  ↳
                </span>
                <h3>
                  One contract.
                  <br />
                  Every layer.
                </h3>
                <p>
                  Shared, validated data shapes keep the web application and API
                  aligned as the simulation takes shape.
                </p>
                <div
                  className="layer-path"
                  aria-label="Architecture: Web, API, simulation"
                >
                  <span>Web</span>
                  <span aria-hidden="true">→</span>
                  <span>API</span>
                  <span aria-hidden="true">→</span>
                  <span>Simulation</span>
                </div>
              </div>
              <div className="panel-footer">
                Protocol <span className="mono">v1</span>
                <span className="footer-tag">Typed contracts</span>
              </div>
            </section>
          </div>

          <section className="next-phase" aria-labelledby="next-title">
            <div>
              <p className="eyebrow">NEXT IN THE ROADMAP · WEEK 03</p>
              <h2 id="next-title">Coordinate shared resources.</h2>
              <p>
                Fair mutexes, a bounded queue, printer leases, workers, and
                invariant checks.
              </p>
            </div>
            <span className="next-arrow" aria-hidden="true">
              ↗
            </span>
          </section>
          <footer className="page-footer">
            <span>Smart Printer Queue Management System</span>
            <span>Educational simulation · No physical printing</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
