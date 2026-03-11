// Extended types for the Gantt chart

export interface Platform {
  id: string
  name: string
  cooldown_days: number
  approval_required: boolean
  color_hex: string
  max_sale_days: number
  special_sales_no_cooldown: boolean
  // New fields for extended platform configuration
  typical_start_day?: string | null
  submission_lead_days?: number
  min_discount_percent?: number
  max_discount_percent?: number
  notes?: string | null
  is_active?: boolean
  created_at?: string
}

export interface PlatformEvent {
  id: string
  platform_id: string
  name: string
  start_date: string
  end_date: string
  event_type: 'seasonal' | 'thirdparty' | 'invitational' | 'festival' | 'custom'
  region?: string | null
  requires_cooldown: boolean
  is_recurring: boolean
  notes?: string | null
  created_at?: string
  updated_at?: string
  platform?: Platform
}

export interface Product {
  id: string
  game_id: string
  name: string
  product_type: 'base' | 'edition' | 'dlc' | 'soundtrack' | 'bundle'
  base_price_usd?: number
  steam_product_id?: string
  launch_date?: string | null
  launch_sale_duration?: number | null  // Duration in days for launch sale (7-14 typical)
  product_aliases?: string[]  // Alternate names for import matching
  created_at: string
  game?: Game
  // Per-product platform availability
  product_platforms?: ProductPlatform[]
}

export interface ProductPlatform {
  id: string
  product_id: string
  platform_id: string
  created_at: string
  platform?: Platform
}

export interface Game {
  id: string
  client_id: string
  name: string
  steam_app_id?: string
  pr_tracking_enabled: boolean
  sales_planning_enabled: boolean
  created_at: string
  client?: Client
}

export interface Client {
  id: string
  name: string
  email?: string
  contact_person?: string
  steam_api_key?: string
  sales_planning_enabled: boolean
  pr_tracking_enabled: boolean
  created_at: string
}

export interface Sale {
  id: string
  product_id: string
  platform_id: string
  start_date: string
  end_date: string
  discount_percentage?: number
  sale_name?: string
  // Database constraint: 'custom' | 'seasonal' | 'festival' | 'special'
  sale_type: 'custom' | 'seasonal' | 'festival' | 'special'
  // Database constraint: 'planned' | 'submitted' | 'confirmed' | 'live' | 'ended'
  status: 'planned' | 'submitted' | 'confirmed' | 'live' | 'ended'
  goal_type?: 'acquisition' | 'visibility' | 'event' | 'revenue'
  notes?: string
  // New fields matching client's Excel workflow
  is_campaign?: boolean
  is_submitted?: boolean
  is_confirmed?: boolean
  comment?: string
  prev_sale_end_date?: string
  // Version tracking - NULL means "working draft" (current edits)
  version_id?: string | null
  created_at: string
  product?: Product
  platform?: Platform
}

// Calendar version for version control / toggling
export interface CalendarVersion {
  id: string
  name: string
  description?: string | null
  sales_snapshot: SaleSnapshot[]
  product_count?: number
  sale_count?: number
  platform_summary?: Record<string, number>
  date_range_start?: string | null
  date_range_end?: string | null
  product_id?: string | null  // Product-scoped versions (preferred)
  client_id?: string | null  // Legacy client-scoped versions
  is_committed: boolean
  committed_at?: string | null
  is_active: boolean  // If true, this version is currently displayed
  created_at: string
  updated_at: string
}

// Sale snapshot stored in version (denormalized for display)
export interface SaleSnapshot {
  product_id: string
  platform_id: string
  start_date: string
  end_date: string
  discount_percentage?: number | null
  sale_name?: string | null
  sale_type: string
  status: string
  notes?: string | null
  product_name?: string
  platform_name?: string
}

export interface SaleWithDetails extends Sale {
  product: Product & { game: Game & { client: Client } }
  platform: Platform
}

export interface TimelineEvent {
  id: string
  name: string
  start_date: string
  end_date: string
  color: string
  platform_id?: string
  event_type?: string
}

export interface ValidationResult {
  valid: boolean
  conflicts: Sale[]
  cooldownEnd: string
  message?: string
}

export interface DayCell {
  date: Date
  dayOfMonth: number
  isWeekend: boolean
  month: number
  year: number
}

// Launch sale conflict information
export interface LaunchConflict {
  eventName: string
  eventStart: Date
  eventEnd: Date
  overlapStart: Date
  overlapEnd: Date
  overlapDays: number
}

// User management types
export type UserRole = 'superadmin' | 'editor' | 'viewer'
export type AccessLevel = 'none' | 'view' | 'edit'
export type FeatureKey = 'sales_timeline' | 'analytics' | 'client_management' | 'platform_settings' | 'excel_export' | 'api_settings' | 'pr_coverage'

export interface UserProfile {
  id: string
  email: string
  display_name: string | null
  role: UserRole
  is_active: boolean
  all_clients: boolean
  created_at: string
  updated_at: string
  client_ids?: string[]
  clients?: { id: string; name: string }[]
  permissions?: UserPermission[]
}

export interface UserPermission {
  id: string
  user_id: string
  feature: FeatureKey
  access_level: AccessLevel
}

export interface UserClient {
  id: string
  user_id: string
  client_id: string
  created_at: string
}

// ============================================
// PR Coverage Module Types
// ============================================

export type OutletTier = 'A' | 'B' | 'C' | 'D'
export type ScanFrequency = 'hourly' | 'every_6h' | 'daily' | 'weekly'
export type CoverageType = 'news' | 'review' | 'preview' | 'interview' | 'trailer' | 'trailer_repost' | 'stream' | 'video' | 'guide' | 'roundup' | 'mention' | 'feature'
export type CoverageSentiment = 'positive' | 'neutral' | 'negative' | 'mixed'
export type ApprovalStatus = 'auto_approved' | 'pending_review' | 'rejected' | 'manually_approved'
export type CoverageSourceType = 'rss' | 'tavily' | 'youtube' | 'twitch' | 'reddit' | 'twitter' | 'tiktok' | 'instagram' | 'manual'
export type KeywordType = 'whitelist' | 'blacklist'

export interface Outlet {
  id: string
  name: string
  domain?: string | null
  country?: string | null
  monthly_unique_visitors?: number | null
  tier?: OutletTier | null
  metacritic_status: boolean
  custom_tags: string[]
  rss_feed_url?: string | null
  scan_frequency: ScanFrequency
  traffic_last_updated?: string | null
  is_active: boolean
  is_blacklisted: boolean
  created_at: string
  updated_at: string
}

export interface CoverageKeyword {
  id: string
  client_id: string
  game_id: string
  keyword: string
  keyword_type: KeywordType
  created_at: string
}

export interface CoverageCampaign {
  id: string
  client_id: string
  game_id?: string | null
  name: string
  start_date?: string | null
  end_date?: string | null
  created_at: string
  updated_at: string
}

export interface CoverageItem {
  id: string
  client_id: string
  game_id?: string | null
  outlet_id?: string | null
  campaign_id?: string | null

  // Article data
  title: string
  url: string
  publish_date?: string | null
  territory?: string | null
  coverage_type?: CoverageType | null

  // Metrics
  monthly_unique_visitors?: number | null
  review_score?: number | null
  quotes?: string | null
  sentiment?: CoverageSentiment | null

  // AI scoring
  relevance_score?: number | null
  relevance_reasoning?: string | null
  is_ai_generated?: boolean | null

  // Approval workflow
  approval_status: ApprovalStatus
  approved_at?: string | null
  approved_by?: string | null

  // Source tracking
  source_type: CoverageSourceType
  source_metadata?: Record<string, unknown>

  // Campaign section
  campaign_section?: string | null

  // Timestamps
  discovered_at: string
  created_at: string
  updated_at: string

  // Joined relations
  outlet?: Outlet
  game?: Game
  client?: Client
  campaign?: CoverageCampaign
}

// ============================================
// API Product Matching Types
// ============================================

export type MappingStatus = 'confirmed' | 'pending' | 'rejected' | 'ignored'
export type MatchType = 'auto_id' | 'auto_name' | 'auto_alias' | 'manual' | 'create_new'

export interface ApiProductMapping {
  id: string
  client_id: string
  product_id: string | null
  game_id: string | null
  platform: string
  external_product_name: string
  steam_package_id?: string | null
  steam_app_id?: string | null
  playstation_sku?: string | null
  match_type: MatchType | string
  confidence_score?: number | null
  status: MappingStatus
  confirmed_at?: string | null
  created_at: string
  updated_at: string
  // Joined relations
  product?: Product
  game?: Game
  client?: Client
}
