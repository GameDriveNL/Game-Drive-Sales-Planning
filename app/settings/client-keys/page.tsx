'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import styles from '../settings.module.css';

// Version: 2.0.0 - Background sync enabled

interface Client {
  id: string;
  name: string;
  email?: string;
}

interface SteamApiKey {
  id: string;
  client_id: string;
  api_key: string;
  publisher_key: string | null;
  app_ids: string[];
  is_active: boolean;
  last_sync_date: string | null;
  clients: Client;
  auto_sync_enabled?: boolean;
  sync_start_date?: string;
  sync_frequency_hours?: number;
  last_auto_sync?: string;
  next_sync_due?: string;
}

interface PlayStationApiKey {
  id: string;
  client_id: string;
  ps_client_id: string;
  client_secret: string;
  scope: string;
  is_active: boolean;
  last_sync_date: string | null;
  clients: Client;
  auto_sync_enabled?: boolean;
  sync_start_date?: string;
  sync_frequency_hours?: number;
  last_auto_sync?: string;
  next_sync_due?: string;
}

interface SyncDebugInfo {
  apiCalled?: boolean;
  endpoint?: string;
  highwatermarkUsed?: string;
  totalDatesFromApi?: number;
  datesAfterFilter?: number;
  sampleDates?: string[];
  newHighwatermark?: string;
  rawResponse?: unknown;
}

// Helper function to safely stringify debug info
function formatDebugInfo(debug: SyncDebugInfo | undefined): string {
  if (!debug) return '';
  try {
    return JSON.stringify(debug, null, 2);
  } catch {
    return 'Unable to format debug info';
  }
}

// Helper function to safely stringify raw response
function formatRawResponse(rawResponse: unknown): string {
  if (!rawResponse) return '';
  try {
    return JSON.stringify(rawResponse, null, 2);
  } catch {
    return 'Unable to format raw response';
  }
}

export default function ClientKeysPage() {
  const { hasAccess, loading: authLoading } = useAuth();
  const canView = hasAccess('api_settings', 'view');
  const canEdit = hasAccess('api_settings', 'edit');
  const [clients, setClients] = useState<Client[] | null>(null);
  const [apiKeys, setApiKeys] = useState<SteamApiKey[] | null>(null);
  const [playstationKeys, setPlaystationKeys] = useState<PlayStationApiKey[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAddPSModal, setShowAddPSModal] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [selectedKey, setSelectedKey] = useState<SteamApiKey | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{valid: boolean; message: string; debug?: SyncDebugInfo} | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    success: boolean;
    message: string;
    rowsImported?: number;
    datesProcessed?: number;
    newUnmatched?: number;
    debug?: SyncDebugInfo;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showAutoSyncModal, setShowAutoSyncModal] = useState(false);
  const [autoSyncLoading, setAutoSyncLoading] = useState(false);
  const [autoSyncError, setAutoSyncError] = useState<string | null>(null);

  // Sync health: track recent failures per client
  const [syncHealth, setSyncHealth] = useState<Record<string, { status: string; error: string | null; failCount: number; lastFailure: string | null }>>({});

  const [formData, setFormData] = useState({
    client_id: '',
    api_key: '',
    publisher_key: '',
    app_ids: ''
  });

  const [psFormData, setPsFormData] = useState({
    client_id: '',
    ps_client_id: '',
    client_secret: '',
    scope: 'data'  // Use provisioned scope - can be space-separated for multiple (e.g., "data dashboard")
  });

  const [testingPSKey, setTestingPSKey] = useState<string | null>(null);
  const [psTestResult, setPsTestResult] = useState<{valid: boolean; message: string} | null>(null);
  const [psSaveError, setPsSaveError] = useState<string | null>(null);
  const [syncingPS, setSyncingPS] = useState(false);
  const [psSyncResult, setPsSyncResult] = useState<{success: boolean; message: string; rowsImported?: number; newUnmatched?: number} | null>(null);
  const [showPSSyncModal, setShowPSSyncModal] = useState(false);
  const [selectedPSKey, setSelectedPSKey] = useState<PlayStationApiKey | null>(null);
  const [showPSAutoSyncModal, setShowPSAutoSyncModal] = useState(false);
  const [psAutoSyncLoading, setPsAutoSyncLoading] = useState(false);
  const [psAutoSyncError, setPsAutoSyncError] = useState<string | null>(null);
  const [psAutoSyncConfig, setPsAutoSyncConfig] = useState({
    start_date: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    frequency_hours: 24
  });

  const [autoSyncConfig, setAutoSyncConfig] = useState({
    start_date: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    frequency_hours: 24
  });

  const [syncOptions, setSyncOptions] = useState({
    start_date: '2024-01-01',  // Default to reasonable historical start date
    end_date: new Date().toISOString().split('T')[0],
    app_id: '',
    force_full_sync: false
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch clients
      const clientsRes = await fetch('/api/clients');
      if (clientsRes.ok) {
        const clientsData = await clientsRes.json();
        setClients(Array.isArray(clientsData) ? clientsData : []);
      }

      // Fetch API keys
      const keysRes = await fetch('/api/steam-api-keys');
      if (keysRes.ok) {
        const keysData = await keysRes.json();
        setApiKeys(Array.isArray(keysData) ? keysData : []);
      }

      // Fetch PlayStation API keys
      const psKeysRes = await fetch('/api/playstation-api-keys');
      if (psKeysRes.ok) {
        const psKeysData = await psKeysRes.json();
        setPlaystationKeys(Array.isArray(psKeysData) ? psKeysData : []);
      }

      // Fetch sync health per client (recent failures)
      const healthRes = await fetch('/api/sync-health');
      if (healthRes.ok) {
        const healthData = await healthRes.json();
        setSyncHealth(healthData);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    }
    setLoading(false);
  };

  const handleAddKey = async () => {
    setSaveError(null);
    try {
      const res = await fetch('/api/steam-api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: formData.client_id,
          api_key: formData.api_key,
          publisher_key: formData.publisher_key || null,
          app_ids: formData.app_ids.split(',').map(s => s.trim()).filter(Boolean)
        })
      });

      if (res.ok) {
        setShowAddModal(false);
        setFormData({ client_id: '', api_key: '', publisher_key: '', app_ids: '' });
        fetchData();
      } else {
        const err = await res.json();
        setSaveError(err.error || 'Failed to save API key');
      }
    } catch (error) {
      console.error('Error adding API key:', error);
      setSaveError('Failed to save API key');
    }
  };

  const handleTestKey = async (clientId: string) => {
    setTestingKey(clientId);
    setTestResult(null);
    try {
      const res = await fetch(`/api/steam-sync?client_id=${clientId}`);
      const data = await res.json();
      setTestResult({ valid: data.valid, message: data.message, debug: data.debug as SyncDebugInfo });
      console.log('Test result:', data);
    } catch (error) {
      setTestResult({ valid: false, message: 'Failed to test API key' });
    }
    setTimeout(() => {
      setTestingKey(null);
    }, 15000);
  };

  const handleSync = async () => {
    if (!selectedKey) return;

    // Validation: Check date range
    if (!syncOptions.start_date || !syncOptions.end_date) {
      alert('Please provide both start and end dates for the sync.');
      return;
    }

    // Validation: Warn if force_full_sync is enabled
    if (syncOptions.force_full_sync) {
      const confirmed = confirm(
        '⚠️ WARNING: Force full sync is enabled.\n\n' +
        'This will re-sync all data from scratch using the Steam API highwatermark reset.\n\n' +
        'Existing data will be updated/merged (not deleted), but this may take longer.\n\n' +
        'Continue with force full sync?'
      );
      if (!confirmed) return;
    }

    // Validation: Warn about date range
    const startDate = new Date(syncOptions.start_date);
    const endDate = new Date(syncOptions.end_date);
    const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDiff > 365) {
      const confirmed = confirm(
        `⚠️ Large Date Range: You are syncing ${daysDiff} days of data.\n\n` +
        `This may take a while to complete. Continue?`
      );
      if (!confirmed) return;
    }

    setSyncing(true);
    setSyncResult(null);
    try {
      // Trigger background job
      const res = await fetch('/api/steam-sync/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedKey.client_id,
          start_date: syncOptions.start_date || undefined,
          end_date: syncOptions.end_date || undefined,
          force_full_sync: syncOptions.force_full_sync
        })
      });

      const data = await res.json();

      if (!data.success) {
        setSyncResult({
          success: false,
          message: data.error || 'Failed to start sync job'
        });
        setSyncing(false);
        return;
      }

      // Job triggered successfully, start polling for status
      const jobId = data.jobId;
      setSyncResult({
        success: true,
        message: 'Sync job started! Processing in background...'
      });

      // Poll for job status every 2 seconds
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/steam-sync/status?job_id=${jobId}`);
          const statusData = await statusRes.json();

          if (statusData.status === 'completed') {
            clearInterval(pollInterval);
            setSyncResult({
              success: true,
              message: `Sync completed! Imported ${statusData.progress.rowsImported} rows from ${statusData.progress.datesProcessed} dates.`,
              rowsImported: statusData.progress.rowsImported,
              datesProcessed: statusData.progress.datesProcessed,
              newUnmatched: statusData.progress.newUnmatched || 0,
            });
            setSyncing(false);
            fetchData();
          } else if (statusData.status === 'failed') {
            clearInterval(pollInterval);
            setSyncResult({
              success: false,
              message: `Sync failed: ${statusData.error}`
            });
            setSyncing(false);
          } else {
            // Still running - update progress
            setSyncResult({
              success: true,
              message: `Syncing... ${statusData.progress.percentComplete}% complete (${statusData.progress.datesProcessed}/${statusData.progress.totalDates} dates)`,
              rowsImported: statusData.progress.rowsImported,
              datesProcessed: statusData.progress.datesProcessed
            });
          }
        } catch (error) {
          console.error('Error polling status:', error);
        }
      }, 2000);

      // Stop polling after 5 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (syncing) {
          setSyncResult({
            success: true,
            message: 'Sync is taking longer than expected. It will continue in the background. Check back later for results.'
          });
          setSyncing(false);
        }
      }, 300000);

    } catch (error) {
      console.error('Sync error:', error);
      setSyncResult({ success: false, message: 'Failed to start sync: ' + String(error) });
      setSyncing(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!confirm('Are you sure you want to delete this API key?')) return;
    try {
      const res = await fetch(`/api/steam-api-keys?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchData();
      }
    } catch (error) {
      console.error('Error deleting API key:', error);
    }
  };

  const handleToggleAutoSync = async (key: SteamApiKey) => {
    if (key.auto_sync_enabled) {
      // Disable auto-sync
      if (!confirm('Are you sure you want to disable auto-sync? This will cancel any pending automatic syncs.')) return;

      setAutoSyncLoading(true);
      try {
        const res = await fetch('/api/steam-sync/auto-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: key.client_id,
            action: 'disable'
          })
        });

        const data = await res.json();
        if (data.success) {
          fetchData();
        } else {
          alert('Failed to disable auto-sync: ' + (data.error || 'Unknown error'));
        }
      } catch (error) {
        console.error('Error disabling auto-sync:', error);
        alert('Failed to disable auto-sync');
      }
      setAutoSyncLoading(false);
    } else {
      // Show modal to enable auto-sync
      setSelectedKey(key);
      setAutoSyncConfig({
        start_date: '2024-01-01',  // Default to reasonable historical start date
        frequency_hours: 24
      });
      setShowAutoSyncModal(true);
      setAutoSyncError(null);
    }
  };

  const handleEnableAutoSync = async () => {
    if (!selectedKey) return;

    setAutoSyncLoading(true);
    setAutoSyncError(null);
    try {
      const res = await fetch('/api/steam-sync/auto-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedKey.client_id,
          action: 'enable',
          start_date: autoSyncConfig.start_date,
          frequency_hours: autoSyncConfig.frequency_hours
        })
      });

      const data = await res.json();
      if (data.success) {
        setShowAutoSyncModal(false);
        fetchData();
      } else {
        setAutoSyncError(data.error || 'Failed to enable auto-sync');
      }
    } catch (error) {
      console.error('Error enabling auto-sync:', error);
      setAutoSyncError('Failed to enable auto-sync');
    }
    setAutoSyncLoading(false);
  };

  const handleTriggerManualSync = async (clientId: string) => {
    setAutoSyncLoading(true);
    try {
      const res = await fetch('/api/steam-sync/auto-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          action: 'trigger'
        })
      });

      const data = await res.json();
      if (data.success) {
        alert('Manual sync triggered! Check the status in a few moments.');
      } else {
        alert('Failed to trigger sync: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error triggering manual sync:', error);
      alert('Failed to trigger manual sync');
    }
    setAutoSyncLoading(false);
  };

  const maskApiKey = (key: string | null) => {
    if (!key || key.length <= 8) return '••••••••';
    return key.substring(0, 4) + '••••••••' + key.substring(key.length - 4);
  };

  // PlayStation API handlers
  const handleAddPSKey = async () => {
    setPsSaveError(null);
    try {
      const res = await fetch('/api/playstation-api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: psFormData.client_id,
          ps_client_id: psFormData.ps_client_id,
          client_secret: psFormData.client_secret,
          scope: psFormData.scope
        })
      });

      if (res.ok) {
        setShowAddPSModal(false);
        setPsFormData({ client_id: '', ps_client_id: '', client_secret: '', scope: 'data' });
        fetchData();
      } else {
        const err = await res.json();
        setPsSaveError(err.error || 'Failed to save PlayStation credentials');
      }
    } catch (error) {
      console.error('Error adding PlayStation credentials:', error);
      setPsSaveError('Failed to save PlayStation credentials');
    }
  };

  const handleTestPSKey = async (clientId: string) => {
    setTestingPSKey(clientId);
    setPsTestResult(null);
    try {
      const res = await fetch(`/api/playstation-sync?client_id=${clientId}`);
      const data = await res.json();
      setPsTestResult({ valid: data.valid, message: data.message });
    } catch (error) {
      setPsTestResult({ valid: false, message: 'Failed to test credentials' });
    }
    setTimeout(() => {
      setTestingPSKey(null);
    }, 15000);
  };

  const handlePSSync = async () => {
    if (!selectedPSKey) return;

    setSyncingPS(true);
    setPsSyncResult(null);
    try {
      const res = await fetch('/api/playstation-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedPSKey.client_id
        })
      });

      const data = await res.json();
      setPsSyncResult({
        success: data.success,
        message: data.message || data.error,
        rowsImported: data.rowsImported,
        newUnmatched: data.newUnmatched || 0,
      });

      if (data.success) {
        fetchData();
      }
    } catch (error) {
      setPsSyncResult({ success: false, message: 'Failed to sync: ' + String(error) });
    }
    setSyncingPS(false);
  };

  const handleDeletePSKey = async (id: string) => {
    if (!confirm('Are you sure you want to delete these PlayStation credentials?')) return;
    try {
      const res = await fetch(`/api/playstation-api-keys?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchData();
      }
    } catch (error) {
      console.error('Error deleting PlayStation credentials:', error);
    }
  };

  const handleTogglePSAutoSync = async (key: PlayStationApiKey) => {
    if (key.auto_sync_enabled) {
      if (!confirm('Are you sure you want to disable auto-sync? This will cancel any pending automatic syncs.')) return;

      setPsAutoSyncLoading(true);
      try {
        const res = await fetch('/api/playstation-sync/auto-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: key.client_id,
            action: 'disable'
          })
        });

        const data = await res.json();
        if (data.success) {
          fetchData();
        } else {
          alert('Failed to disable auto-sync: ' + (data.error || 'Unknown error'));
        }
      } catch (error) {
        console.error('Error disabling PlayStation auto-sync:', error);
        alert('Failed to disable auto-sync');
      }
      setPsAutoSyncLoading(false);
    } else {
      setSelectedPSKey(key);
      setPsAutoSyncConfig({
        start_date: '2024-01-01',
        frequency_hours: 24
      });
      setShowPSAutoSyncModal(true);
      setPsAutoSyncError(null);
    }
  };

  const handleEnablePSAutoSync = async () => {
    if (!selectedPSKey) return;

    setPsAutoSyncLoading(true);
    setPsAutoSyncError(null);
    try {
      const res = await fetch('/api/playstation-sync/auto-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: selectedPSKey.client_id,
          action: 'enable',
          start_date: psAutoSyncConfig.start_date,
          frequency_hours: psAutoSyncConfig.frequency_hours
        })
      });

      const data = await res.json();
      if (data.success) {
        setShowPSAutoSyncModal(false);
        fetchData();
      } else {
        setPsAutoSyncError(data.error || 'Failed to enable auto-sync');
      }
    } catch (error) {
      console.error('Error enabling PlayStation auto-sync:', error);
      setPsAutoSyncError('Failed to enable auto-sync');
    }
    setPsAutoSyncLoading(false);
  };

  const handleTriggerPSManualSync = async (clientId: string) => {
    setPsAutoSyncLoading(true);
    try {
      const res = await fetch('/api/playstation-sync/auto-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          action: 'trigger'
        })
      });

      const data = await res.json();
      if (data.success) {
        alert('Manual sync triggered! Check the status in a few moments.');
      } else {
        alert('Failed to trigger sync: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error triggering PlayStation manual sync:', error);
      alert('Failed to trigger manual sync');
    }
    setPsAutoSyncLoading(false);
  };

  // Get clients that don't have PlayStation credentials yet
  const availablePSClients = (clients || []).filter(
    client => !(playstationKeys || []).some(key => key.client_id === client.id)
  );

  const formatNextSync = (nextSyncDue: string | undefined) => {
    if (!nextSyncDue) return 'Not scheduled';
    const date = new Date(nextSyncDue);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffMs < 0) return 'Overdue';
    if (diffHours < 1) return `in ${diffMins}m`;
    if (diffHours < 24) return `in ${diffHours}h ${diffMins}m`;
    const diffDays = Math.floor(diffHours / 24);
    return `in ${diffDays}d ${diffHours % 24}h`;
  };

  // Get clients that don't have an API key yet
  const availableClients = (clients || []).filter(
    client => !(apiKeys || []).some(key => key.client_id === client.id)
  );

  if (authLoading || loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>Loading...</div>
    );
  }

  if (!canView) {
    return (
      <div style={{ textAlign: 'center', padding: '60px' }}>
        <h2>Access Denied</h2>
        <p>You don&apos;t have permission to view API Settings.</p>
      </div>
    );
  }

  return (
    <>
      {/* Steam API Keys Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h2>Steam API Keys</h2>
          </div>
          <button className={styles.addButton} onClick={() => setShowAddModal(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add API Key
          </button>
        </div>

        {loading ? (
          <div className={styles.emptyState}>
            <div className={styles.spinner}></div>
            <p>Loading...</p>
          </div>
        ) : !apiKeys || apiKeys.length === 0 ? (
          <div className={styles.emptyState}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            <p>No Steam API keys configured yet</p>
            <button className={styles.addButton} onClick={() => setShowAddModal(true)}>
              Add Your First API Key
            </button>
          </div>
        ) : (
          <div className={styles.keysList}>
            {apiKeys?.map((key) => (
              <div key={key.id} className={styles.keyCard}>
                <div className={styles.keyInfo}>
                  <span className={styles.clientBadge}>{key.clients?.name || 'Unknown Client'}</span>
                  <div className={styles.keyDetails}>
                    <span className={styles.keyMasked}>{maskApiKey(key.api_key)}</span>
                    <div className={styles.keyMeta}>
                      <span>{key.publisher_key ? '✓ Financial API Key' : '○ No Financial Key'}</span>
                      <span>{key.app_ids?.length || 0} App IDs</span>
                      {key.last_sync_date && <span>Last sync: {key.last_sync_date}</span>}
                    </div>
                    {key.auto_sync_enabled && (
                      <div style={{ marginTop: '8px', padding: '8px', background: '#dbeafe', borderRadius: '4px', fontSize: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M23 4v6h-6"/>
                            <path d="M1 20v-6h6"/>
                            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/>
                            <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/>
                          </svg>
                          <strong style={{ color: '#1e40af' }}>Auto-sync enabled</strong>
                        </div>
                        <div style={{ color: '#1e3a8a', fontSize: '11px' }}>
                          <div>Syncing from {key.sync_start_date} to present</div>
                          <div>Every {key.sync_frequency_hours}h • Next: {formatNextSync(key.next_sync_due)}</div>
                        </div>
                        <button
                          onClick={() => handleTriggerManualSync(key.client_id)}
                          disabled={autoSyncLoading}
                          style={{
                            marginTop: '6px',
                            padding: '4px 8px',
                            background: '#d22939',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            fontSize: '11px',
                            cursor: autoSyncLoading ? 'not-allowed' : 'pointer',
                            opacity: autoSyncLoading ? 0.6 : 1
                          }}
                        >
                          Sync Now
                        </button>
                      </div>
                    )}
                    {syncHealth[key.client_id]?.failCount > 0 && (
                      <div style={{
                        marginTop: '8px',
                        padding: '10px 12px',
                        background: '#fef2f2',
                        border: '1px solid #fecaca',
                        borderRadius: '6px',
                        fontSize: '12px',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <span style={{ fontSize: '14px' }}>&#x26A0;</span>
                          <strong style={{ color: '#991b1b' }}>
                            Sync failing{syncHealth[key.client_id].failCount > 1 ? ` (${syncHealth[key.client_id].failCount} consecutive failures)` : ''}
                          </strong>
                        </div>
                        <div style={{ color: '#7f1d1d', fontSize: '11px', lineHeight: '1.4' }}>
                          <div style={{ marginBottom: '4px' }}>{syncHealth[key.client_id].error}</div>
                          {syncHealth[key.client_id].error?.includes('403') && (
                            <div style={{ marginTop: '6px', padding: '6px 8px', background: '#fff', borderRadius: '4px', border: '1px solid #fde8e8' }}>
                              <strong>How to fix:</strong> Your Steam Financial API key may be expired or lack permissions.
                              Go to <a href="https://partner.steamgames.com/pub/groups/" target="_blank" rel="noopener" style={{ color: '#1e40af', textDecoration: 'underline' }}>partner.steamgames.com/pub/groups/</a> and
                              verify your Financial API Group is active, then re-copy the key.
                            </div>
                          )}
                          {syncHealth[key.client_id].error?.includes('0 financial dates') && (
                            <div style={{ marginTop: '6px', padding: '6px 8px', background: '#fff', borderRadius: '4px', border: '1px solid #fde8e8' }}>
                              <strong>How to fix:</strong> Your API key connected successfully but Steam returned no financial data.
                              This usually means the key is a regular Web API key, not a <strong>Financial</strong> Web API key.
                              Go to <a href="https://partner.steamgames.com/pub/groups/" target="_blank" rel="noopener" style={{ color: '#1e40af', textDecoration: 'underline' }}>partner.steamgames.com/pub/groups/</a> and
                              create a <strong>Financial API Group</strong> to get the correct key.
                            </div>
                          )}
                          {syncHealth[key.client_id].lastFailure && (
                            <div style={{ marginTop: '4px', color: '#9ca3af', fontSize: '10px' }}>
                              Last failure: {new Date(syncHealth[key.client_id].lastFailure!).toLocaleString()}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {testingKey === key.client_id && testResult && (
                    <div className={`${styles.statusBadge} ${testResult.valid ? styles.valid : styles.invalid}`}>
                      <strong>{testResult.valid ? '✓ Connected' : '✗ Failed'}</strong>
                      <span style={{ fontSize: '11px', display: 'block', marginTop: '2px' }}>{testResult.message}</span>
                      {testResult.debug && (
                        <details style={{ marginTop: '8px', fontSize: '10px' }}>
                          <summary>Debug Info</summary>
                          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#f1f5f9', padding: '8px', borderRadius: '4px', marginTop: '4px' }}>
                            {formatDebugInfo(testResult.debug)}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
                <div className={styles.keyActions}>
                  <button
                    className={`${styles.actionButton} ${key.auto_sync_enabled ? styles.autoSyncOn : styles.autoSyncOff}`}
                    onClick={() => handleToggleAutoSync(key)}
                    disabled={autoSyncLoading}
                    title={key.auto_sync_enabled ? 'Disable auto-sync' : 'Enable auto-sync'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M8 12l2 2 4-4"/>
                    </svg>
                    Auto
                  </button>
                  <button
                    className={`${styles.actionButton} ${styles.test}`}
                    onClick={() => handleTestKey(key.client_id)}
                    disabled={testingKey === key.client_id}
                  >
                    {testingKey === key.client_id ? (
                      <span className={styles.spinner}></span>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        Test
                      </>
                    )}
                  </button>
                  <button
                    className={`${styles.actionButton} ${styles.sync}`}
                    onClick={() => { setSelectedKey(key); setShowSyncModal(true); setSyncResult(null); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M23 4v6h-6"/>
                      <path d="M1 20v-6h6"/>
                      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/>
                      <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/>
                    </svg>
                    Sync
                  </button>
                  <button
                    className={`${styles.actionButton} ${styles.delete}`}
                    onClick={() => handleDeleteKey(key.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
                      <path d="M10 11v6"/>
                      <path d="M14 11v6"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info Section */}
      <div className={styles.section}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>How to Get Your Steam Financial API Key</h3>
        <ol style={{ margin: 0, paddingLeft: '20px', color: '#64748b', lineHeight: '1.8' }}>
          <li>Go to <a href="https://partner.steamgames.com/pub/groups/" target="_blank" rel="noopener noreferrer" style={{ color: '#1b2838' }}>partner.steamgames.com/pub/groups/</a></li>
          <li>Click <strong>&quot;Create Financial API Group&quot;</strong> (or select existing one)</li>
          <li>The <strong>Financial Web API Key</strong> will be displayed on the group page</li>
          <li>Copy this key and paste it in the &quot;Financial Web API Key&quot; field above</li>
          <li>Optional: Add whitelisted IPs for extra security</li>
        </ol>
        <p style={{ marginTop: '16px', padding: '12px', background: '#dbeafe', borderRadius: '6px', fontSize: '14px' }}>
          <strong>New in June 2025:</strong> Steam now offers the <a href="https://steamcommunity.com/groups/steamworks/announcements/detail/532096678169150062" target="_blank" rel="noopener noreferrer" style={{ color: '#1b2838' }}>IPartnerFinancialsService API</a> for programmatic access to sales data including revenue, units, and regional breakdown.
        </p>
      </div>

      {/* PlayStation API Keys Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionIcon} style={{ background: '#003791' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 12h8"/>
                <path d="M12 8v8"/>
              </svg>
            </div>
            <h2>PlayStation API Credentials</h2>
          </div>
          <button className={styles.addButton} onClick={() => setShowAddPSModal(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Credentials
          </button>
        </div>

        {loading ? (
          <div className={styles.emptyState}>
            <div className={styles.spinner}></div>
            <p>Loading...</p>
          </div>
        ) : !playstationKeys || playstationKeys.length === 0 ? (
          <div className={styles.emptyState}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            <p>No PlayStation API credentials configured yet</p>
            <button className={styles.addButton} onClick={() => setShowAddPSModal(true)}>
              Add Your First Credentials
            </button>
          </div>
        ) : (
          <div className={styles.keysList}>
            {playstationKeys?.map((key) => (
              <div key={key.id} className={styles.keyCard}>
                <div className={styles.keyInfo}>
                  <span className={styles.clientBadge} style={{ background: '#003791' }}>{key.clients?.name || 'Unknown Client'}</span>
                  <div className={styles.keyDetails}>
                    <span className={styles.keyMasked}>{maskApiKey(key.ps_client_id)}</span>
                    <div className={styles.keyMeta}>
                      <span>Scope: {key.scope}</span>
                      {key.last_sync_date && <span>Last sync: {key.last_sync_date}</span>}
                    </div>
                    {key.auto_sync_enabled && (
                      <div style={{ marginTop: '8px', padding: '8px', background: '#dbeafe', borderRadius: '4px', fontSize: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M23 4v6h-6"/>
                            <path d="M1 20v-6h6"/>
                            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/>
                            <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/>
                          </svg>
                          <strong style={{ color: '#1e40af' }}>Auto-sync enabled</strong>
                        </div>
                        <div style={{ color: '#1e3a8a', fontSize: '11px' }}>
                          <div>Syncing from {key.sync_start_date} to present</div>
                          <div>Every {key.sync_frequency_hours}h • Next: {formatNextSync(key.next_sync_due)}</div>
                        </div>
                        <button
                          onClick={() => handleTriggerPSManualSync(key.client_id)}
                          disabled={psAutoSyncLoading}
                          style={{
                            marginTop: '6px',
                            padding: '4px 8px',
                            background: '#d22939',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            fontSize: '11px',
                            cursor: psAutoSyncLoading ? 'not-allowed' : 'pointer',
                            opacity: psAutoSyncLoading ? 0.6 : 1
                          }}
                        >
                          Sync Now
                        </button>
                      </div>
                    )}
                  </div>
                  {testingPSKey === key.client_id && psTestResult && (
                    <div className={`${styles.statusBadge} ${psTestResult.valid ? styles.valid : styles.invalid}`}>
                      <strong>{psTestResult.valid ? '✓ Connected' : '✗ Failed'}</strong>
                      <span style={{ fontSize: '11px', display: 'block', marginTop: '2px' }}>{psTestResult.message}</span>
                    </div>
                  )}
                </div>
                <div className={styles.keyActions}>
                  <button
                    className={`${styles.actionButton} ${key.auto_sync_enabled ? styles.autoSyncOn : styles.autoSyncOff}`}
                    onClick={() => handleTogglePSAutoSync(key)}
                    disabled={psAutoSyncLoading}
                    title={key.auto_sync_enabled ? 'Disable auto-sync' : 'Enable auto-sync'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M8 12l2 2 4-4"/>
                    </svg>
                    Auto
                  </button>
                  <button
                    className={`${styles.actionButton} ${styles.test}`}
                    onClick={() => handleTestPSKey(key.client_id)}
                    disabled={testingPSKey === key.client_id}
                  >
                    {testingPSKey === key.client_id ? (
                      <span className={styles.spinner}></span>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        Test
                      </>
                    )}
                  </button>
                  <button
                    className={`${styles.actionButton} ${styles.sync}`}
                    onClick={() => { setSelectedPSKey(key); setShowPSSyncModal(true); setPsSyncResult(null); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M23 4v6h-6"/>
                      <path d="M1 20v-6h6"/>
                      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/>
                      <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/>
                    </svg>
                    Sync
                  </button>
                  <button
                    className={`${styles.actionButton} ${styles.delete}`}
                    onClick={() => handleDeletePSKey(key.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
                      <path d="M10 11v6"/>
                      <path d="M14 11v6"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* PlayStation Info Section */}
      <div className={styles.section}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>How to Get Your PlayStation Analytics API Credentials</h3>
        <ol style={{ margin: 0, paddingLeft: '20px', color: '#64748b', lineHeight: '1.8' }}>
          <li>Log in to <a href="https://partners.playstation.net/" target="_blank" rel="noopener noreferrer" style={{ color: '#003791' }}>PlayStation Partners</a></li>
          <li>Navigate to <strong>PlayStation Partners Analytics</strong></li>
          <li>Request API access if not already enabled</li>
          <li>Generate a <strong>Client ID</strong> and <strong>Client Secret</strong> for API access</li>
          <li>Copy these credentials and add them above</li>
        </ol>
        <p style={{ marginTop: '16px', padding: '12px', background: '#e0e7ff', borderRadius: '6px', fontSize: '14px' }}>
          <strong>Note:</strong> PlayStation Analytics API provides programmatic access to sales data, revenue, and regional breakdowns via OAuth 2.0 authentication and SQL queries.
        </p>
      </div>

      {/* Add API Key Modal */}
      {showAddModal && (
        <div className={styles.modalOverlay} onClick={() => setShowAddModal(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Add Steam API Key</h3>
              <button className={styles.closeButton} onClick={() => setShowAddModal(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {saveError && (
              <div style={{ padding: '12px', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', marginBottom: '16px', fontSize: '14px' }}>
                {saveError}
              </div>
            )}

            <div className={styles.formGroup}>
              <label>Client *</label>
              <select
                value={formData.client_id}
                onChange={e => setFormData({...formData, client_id: e.target.value})}
              >
                <option value="">Select a client...</option>
                {clients?.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
              <small>{availableClients?.length || 0} clients without API keys</small>
            </div>

            <div className={styles.formGroup}>
              <label>Financial Web API Key (Required for Sales Data) *</label>
              <input
                type="text"
                placeholder="Enter your Financial Web API key"
                value={formData.publisher_key}
                onChange={e => setFormData({...formData, publisher_key: e.target.value})}
                style={{ fontFamily: 'monospace' }}
              />
              <small>From Steamworks → Manage Groups → Financial API Group</small>
            </div>

            <div className={styles.formGroup}>
              <label>Steam Web API Key (Optional)</label>
              <input
                type="text"
                placeholder="Enter your Steam Web API key"
                value={formData.api_key}
                onChange={e => setFormData({...formData, api_key: e.target.value})}
                style={{ fontFamily: 'monospace' }}
              />
              <small>Basic API key from steamcommunity.com/dev/apikey</small>
            </div>

            <div className={styles.formGroup}>
              <label>App IDs (Optional)</label>
              <input
                type="text"
                placeholder="730, 440, 570"
                value={formData.app_ids}
                onChange={e => setFormData({...formData, app_ids: e.target.value})}
              />
              <small>Comma-separated list of Steam App IDs to track</small>
            </div>

            <div className={styles.modalActions}>
              <button className={styles.cancelButton} onClick={() => setShowAddModal(false)}>
                Cancel
              </button>
              <button
                className={styles.saveButton}
                onClick={handleAddKey}
                disabled={!formData.client_id || !formData.publisher_key}
              >
                Save API Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sync Modal */}
      {showSyncModal && selectedKey && (
        <div className={styles.modalOverlay} onClick={() => { setShowSyncModal(false); setSyncResult(null); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: '550px' }}>
            <div className={styles.modalHeader}>
              <h3>Sync Steam Data</h3>
              <button className={styles.closeButton} onClick={() => { setShowSyncModal(false); setSyncResult(null); }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <p style={{ color: '#64748b', marginBottom: '16px' }}>
              Sync financial data for <strong>{selectedKey.clients?.name}</strong> using the IPartnerFinancialsService API.
            </p>

            <div className={styles.syncOptions}>
              <div className={styles.dateRange}>
                <div className={styles.formGroup}>
                  <label>Start Date</label>
                  <input
                    type="date"
                    value={syncOptions.start_date}
                    onChange={e => setSyncOptions({...syncOptions, start_date: e.target.value})}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>End Date</label>
                  <input
                    type="date"
                    value={syncOptions.end_date}
                    onChange={e => setSyncOptions({...syncOptions, end_date: e.target.value})}
                  />
                </div>
              </div>

              <div className={styles.formGroup}>
                <label>Specific App ID (Optional)</label>
                <input
                  type="text"
                  placeholder="Leave empty for all apps"
                  value={syncOptions.app_id}
                  onChange={e => setSyncOptions({...syncOptions, app_id: e.target.value})}
                />
              </div>

              <div className={styles.formGroup}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={syncOptions.force_full_sync}
                    onChange={e => setSyncOptions({...syncOptions, force_full_sync: e.target.checked})}
                    style={{ width: '16px', height: '16px' }}
                  />
                  Force full sync (ignore cached highwatermark)
                </label>
                <small>Use this to re-sync all data from scratch</small>
              </div>
            </div>

            {syncResult && (
              <div className={`${styles.syncResult} ${syncResult.success ? styles.success : styles.error}`}>
                <strong>{syncResult.success ? '✓ Success' : '✗ Error'}</strong>
                <p style={{ margin: '8px 0 0 0', fontSize: '14px' }}>{syncResult.message}</p>
                {syncResult.rowsImported !== undefined && (
                  <p style={{ margin: '4px 0 0 0', fontSize: '13px', opacity: 0.8 }}>
                    {syncResult.rowsImported} rows imported from {syncResult.datesProcessed || 0} date(s)
                  </p>
                )}

                {syncResult.newUnmatched !== undefined && syncResult.newUnmatched > 0 && (
                  <p style={{ margin: '8px 0 0 0', fontSize: '13px', padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '6px', color: '#9a3412' }}>
                    {syncResult.newUnmatched} new product(s) need matching.{' '}
                    <Link href="/settings/product-matching" style={{ color: '#b8232f', textDecoration: 'underline', fontWeight: 500 }}>
                      Review now
                    </Link>
                  </p>
                )}

                {/* Debug Information */}
                {syncResult.debug && (
                  <details style={{ marginTop: '12px' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '12px', color: '#64748b' }}>
                      Show API Debug Info
                    </summary>
                    <div style={{
                      marginTop: '8px',
                      padding: '12px',
                      background: '#f8fafc',
                      borderRadius: '6px',
                      fontSize: '12px',
                      fontFamily: 'monospace'
                    }}>
                      <div><strong>API Called:</strong> {syncResult.debug.apiCalled ? 'Yes' : 'No'}</div>
                      <div><strong>Endpoint:</strong> {syncResult.debug.endpoint || 'N/A'}</div>
                      <div><strong>Highwatermark Used:</strong> {syncResult.debug.highwatermarkUsed || 'N/A'}</div>
                      <div><strong>Total Dates from API:</strong> {String(syncResult.debug.totalDatesFromApi ?? 'N/A')}</div>
                      <div><strong>Dates After Filter:</strong> {String(syncResult.debug.datesAfterFilter ?? 'N/A')}</div>
                      {syncResult.debug.sampleDates && syncResult.debug.sampleDates.length > 0 && (
                        <div><strong>Sample Dates:</strong> {syncResult.debug.sampleDates.join(', ')}</div>
                      )}
                      {syncResult.debug.rawResponse !== undefined && syncResult.debug.rawResponse !== null && (
                        <details style={{ marginTop: '8px' }}>
                          <summary style={{ cursor: 'pointer' }}>Raw API Response</summary>
                          <pre style={{
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            maxHeight: '200px',
                            overflow: 'auto',
                            background: '#e2e8f0',
                            padding: '8px',
                            borderRadius: '4px',
                            marginTop: '4px'
                          }}>
                            {formatRawResponse(syncResult.debug.rawResponse)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </details>
                )}
              </div>
            )}

            {!selectedKey.publisher_key && (
              <div style={{ padding: '12px', background: '#fef3c7', borderRadius: '6px', fontSize: '14px', marginTop: '12px' }}>
                <strong>No Financial API Key:</strong> Add a Financial Web API Key to sync sales data.
                <a href="https://partner.steamgames.com/pub/groups/" target="_blank" rel="noopener noreferrer" style={{ marginLeft: '4px', color: '#1b2838' }}>
                  Get one here
                </a>
              </div>
            )}

            <div className={styles.modalActions}>
              <button className={styles.cancelButton} onClick={() => { setShowSyncModal(false); setSyncResult(null); }}>
                Close
              </button>
              <button
                className={styles.saveButton}
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? (
                  <>
                    <span className={styles.spinner}></span>
                    Syncing...
                  </>
                ) : (
                  'Start Sync'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Sync Configuration Modal */}
      {showAutoSyncModal && selectedKey && (
        <div className={styles.modalOverlay} onClick={() => { setShowAutoSyncModal(false); setAutoSyncError(null); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className={styles.modalHeader}>
              <h3>Enable Auto-Sync</h3>
              <button className={styles.closeButton} onClick={() => { setShowAutoSyncModal(false); setAutoSyncError(null); }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <p style={{ color: '#64748b', marginBottom: '16px' }}>
              Automatically sync data from a start date to the present day on a regular schedule. No end date required - your data will always be current.
            </p>

            {autoSyncError && (
              <div style={{ padding: '12px', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', marginBottom: '16px', fontSize: '14px' }}>
                {autoSyncError}
              </div>
            )}

            <div className={styles.formGroup}>
              <label>Start Date *</label>
              <input
                type="date"
                value={autoSyncConfig.start_date}
                onChange={e => setAutoSyncConfig({...autoSyncConfig, start_date: e.target.value})}
              />
              <small>Data will be synced from this date to the present day</small>
            </div>

            <div className={styles.formGroup}>
              <label>Sync Frequency (hours) *</label>
              <select
                value={autoSyncConfig.frequency_hours}
                onChange={e => setAutoSyncConfig({...autoSyncConfig, frequency_hours: parseInt(e.target.value)})}
              >
                <option value="1">Every hour</option>
                <option value="3">Every 3 hours</option>
                <option value="6">Every 6 hours</option>
                <option value="12">Every 12 hours</option>
                <option value="24">Once per day (24 hours)</option>
                <option value="48">Every 2 days (48 hours)</option>
                <option value="72">Every 3 days (72 hours)</option>
                <option value="168">Once per week (168 hours)</option>
              </select>
              <small>How often to automatically sync new data</small>
            </div>

            {!selectedKey.publisher_key && (
              <div style={{ padding: '12px', background: '#fef3c7', borderRadius: '6px', fontSize: '14px', marginTop: '12px' }}>
                <strong>No Financial API Key:</strong> Add a Financial Web API Key to sync sales data.
              </div>
            )}

            <div style={{ padding: '12px', background: '#dbeafe', borderRadius: '6px', fontSize: '13px', marginTop: '12px' }}>
              <strong>How it works:</strong>
              <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
                <li>Syncs data from your start date to today automatically</li>
                <li>Runs on your chosen schedule without manual intervention</li>
                <li>No end date - always keeps data current</li>
                <li>You can trigger manual syncs anytime</li>
              </ul>
            </div>

            <div className={styles.modalActions}>
              <button className={styles.cancelButton} onClick={() => { setShowAutoSyncModal(false); setAutoSyncError(null); }}>
                Cancel
              </button>
              <button
                className={styles.saveButton}
                onClick={handleEnableAutoSync}
                disabled={autoSyncLoading || !autoSyncConfig.start_date}
              >
                {autoSyncLoading ? (
                  <>
                    <span className={styles.spinner}></span>
                    Enabling...
                  </>
                ) : (
                  'Enable Auto-Sync'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PlayStation Auto-Sync Configuration Modal */}
      {showPSAutoSyncModal && selectedPSKey && (
        <div className={styles.modalOverlay} onClick={() => { setShowPSAutoSyncModal(false); setPsAutoSyncError(null); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className={styles.modalHeader}>
              <h3>Enable PlayStation Auto-Sync</h3>
              <button className={styles.closeButton} onClick={() => { setShowPSAutoSyncModal(false); setPsAutoSyncError(null); }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <p style={{ color: '#64748b', marginBottom: '16px' }}>
              Automatically sync PlayStation sales data from a start date to the present day on a regular schedule.
            </p>

            {psAutoSyncError && (
              <div style={{ padding: '12px', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', marginBottom: '16px', fontSize: '14px' }}>
                {psAutoSyncError}
              </div>
            )}

            <div className={styles.formGroup}>
              <label>Start Date *</label>
              <input
                type="date"
                value={psAutoSyncConfig.start_date}
                onChange={e => setPsAutoSyncConfig({...psAutoSyncConfig, start_date: e.target.value})}
              />
              <small>Data will be synced from this date to the present day</small>
            </div>

            <div className={styles.formGroup}>
              <label>Sync Frequency (hours) *</label>
              <select
                value={psAutoSyncConfig.frequency_hours}
                onChange={e => setPsAutoSyncConfig({...psAutoSyncConfig, frequency_hours: parseInt(e.target.value)})}
              >
                <option value="1">Every hour</option>
                <option value="3">Every 3 hours</option>
                <option value="6">Every 6 hours</option>
                <option value="12">Every 12 hours</option>
                <option value="24">Once per day (24 hours)</option>
                <option value="48">Every 2 days (48 hours)</option>
                <option value="72">Every 3 days (72 hours)</option>
                <option value="168">Once per week (168 hours)</option>
              </select>
              <small>How often to automatically sync new data</small>
            </div>

            <div style={{ padding: '12px', background: '#dbeafe', borderRadius: '6px', fontSize: '13px', marginTop: '12px' }}>
              <strong>How it works:</strong>
              <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
                <li>Exports data from all PlayStation datasets automatically</li>
                <li>Filters records by your start date to present</li>
                <li>Runs on your chosen schedule without manual intervention</li>
                <li>You can trigger manual syncs anytime via &quot;Sync Now&quot;</li>
              </ul>
            </div>

            <div className={styles.modalActions}>
              <button className={styles.cancelButton} onClick={() => { setShowPSAutoSyncModal(false); setPsAutoSyncError(null); }}>
                Cancel
              </button>
              <button
                className={styles.saveButton}
                onClick={handleEnablePSAutoSync}
                disabled={psAutoSyncLoading || !psAutoSyncConfig.start_date}
              >
                {psAutoSyncLoading ? (
                  <>
                    <span className={styles.spinner}></span>
                    Enabling...
                  </>
                ) : (
                  'Enable Auto-Sync'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add PlayStation Credentials Modal */}
      {showAddPSModal && (
        <div className={styles.modalOverlay} onClick={() => setShowAddPSModal(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Add PlayStation Credentials</h3>
              <button className={styles.closeButton} onClick={() => setShowAddPSModal(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {psSaveError && (
              <div style={{ padding: '12px', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', marginBottom: '16px', fontSize: '14px' }}>
                {psSaveError}
              </div>
            )}

            <div className={styles.formGroup}>
              <label>Client *</label>
              <select
                value={psFormData.client_id}
                onChange={e => setPsFormData({...psFormData, client_id: e.target.value})}
              >
                <option value="">Select a client...</option>
                {clients?.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
              <small>{availablePSClients?.length || 0} clients without PlayStation credentials</small>
            </div>

            <div className={styles.formGroup}>
              <label>PlayStation Client ID *</label>
              <input
                type="text"
                placeholder="Enter your PlayStation Client ID"
                value={psFormData.ps_client_id}
                onChange={e => setPsFormData({...psFormData, ps_client_id: e.target.value})}
                style={{ fontFamily: 'monospace' }}
              />
              <small>From PlayStation Partners Analytics API settings</small>
            </div>

            <div className={styles.formGroup}>
              <label>Client Secret *</label>
              <input
                type="password"
                placeholder="Enter your Client Secret"
                value={psFormData.client_secret}
                onChange={e => setPsFormData({...psFormData, client_secret: e.target.value})}
                style={{ fontFamily: 'monospace' }}
              />
              <small>Keep this secret secure</small>
            </div>

            <div className={styles.formGroup}>
              <label>Scopes</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                {[
                  { value: 'data', label: 'data', description: 'Access to analytics data exports and queries' },
                  { value: 'dashboard', label: 'dashboard', description: 'Access to dashboard and reporting features' }
                ].map(scopeOption => {
                  const selectedScopes = psFormData.scope.split(' ').filter(s => s.trim());
                  const isChecked = selectedScopes.includes(scopeOption.value);
                  return (
                    <label
                      key={scopeOption.value}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '8px',
                        padding: '10px 12px',
                        background: isChecked ? '#e0e7ff' : '#f8fafc',
                        border: isChecked ? '1px solid #6366f1' : '1px solid #e2e8f0',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={e => {
                          const currentScopes = psFormData.scope.split(' ').filter(s => s.trim());
                          let newScopes: string[];
                          if (e.target.checked) {
                            newScopes = [...currentScopes, scopeOption.value];
                          } else {
                            newScopes = currentScopes.filter(s => s !== scopeOption.value);
                          }
                          setPsFormData({...psFormData, scope: newScopes.join(' ')});
                        }}
                        style={{ marginTop: '2px' }}
                      />
                      <div>
                        <div style={{ fontWeight: 500, fontFamily: 'monospace', fontSize: '14px' }}>
                          {scopeOption.label}
                        </div>
                        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                          {scopeOption.description}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <small style={{ marginTop: '8px', display: 'block' }}>
                Select the scopes your credentials are provisioned for. Contact PlayStation Partners if unsure.
              </small>
            </div>

            <div className={styles.modalActions}>
              <button className={styles.cancelButton} onClick={() => setShowAddPSModal(false)}>
                Cancel
              </button>
              <button
                className={styles.saveButton}
                onClick={handleAddPSKey}
                disabled={!psFormData.client_id || !psFormData.ps_client_id || !psFormData.client_secret}
              >
                Save Credentials
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PlayStation Sync Modal */}
      {showPSSyncModal && selectedPSKey && (
        <div className={styles.modalOverlay} onClick={() => { setShowPSSyncModal(false); setPsSyncResult(null); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className={styles.modalHeader}>
              <h3>Sync PlayStation Data</h3>
              <button className={styles.closeButton} onClick={() => { setShowPSSyncModal(false); setPsSyncResult(null); }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <p style={{ color: '#64748b', marginBottom: '16px' }}>
              Sync analytics data for <strong>{selectedPSKey.clients?.name}</strong> from PlayStation Partners Analytics API.
            </p>

            {psSyncResult && (
              <div className={`${styles.syncResult} ${psSyncResult.success ? styles.success : styles.error}`}>
                <strong>{psSyncResult.success ? '✓ Success' : '✗ Error'}</strong>
                <p style={{ margin: '8px 0 0 0', fontSize: '14px' }}>{psSyncResult.message}</p>
                {psSyncResult.rowsImported !== undefined && (
                  <p style={{ margin: '4px 0 0 0', fontSize: '13px', opacity: 0.8 }}>
                    {psSyncResult.rowsImported} rows imported
                  </p>
                )}
                {psSyncResult.newUnmatched !== undefined && psSyncResult.newUnmatched > 0 && (
                  <p style={{ margin: '8px 0 0 0', fontSize: '13px', padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '6px', color: '#9a3412' }}>
                    {psSyncResult.newUnmatched} new product(s) need matching.{' '}
                    <Link href="/settings/product-matching" style={{ color: '#b8232f', textDecoration: 'underline', fontWeight: 500 }}>
                      Review now
                    </Link>
                  </p>
                )}
              </div>
            )}

            <div style={{ padding: '12px', background: '#e0e7ff', borderRadius: '6px', fontSize: '13px', marginTop: '12px' }}>
              <strong>What gets synced:</strong>
              <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
                <li>Sales data from all available datasets</li>
                <li>Revenue, units sold, and regional breakdowns</li>
                <li>Data is stored in the performance metrics table</li>
              </ul>
            </div>

            <div className={styles.modalActions}>
              <button className={styles.cancelButton} onClick={() => { setShowPSSyncModal(false); setPsSyncResult(null); }}>
                Close
              </button>
              <button
                className={styles.saveButton}
                onClick={handlePSSync}
                disabled={syncingPS}
                style={{ background: '#003791' }}
              >
                {syncingPS ? (
                  <>
                    <span className={styles.spinner}></span>
                    Syncing...
                  </>
                ) : (
                  'Start Sync'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
