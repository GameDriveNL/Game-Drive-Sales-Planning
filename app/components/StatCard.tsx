'use client'

import { useState, useRef, useEffect } from 'react'
import styles from './StatCard.module.css'

interface TooltipItem {
  label: string
  sublabel?: string
  color?: string
  warning?: boolean
  actionLabel?: string
  onAction?: () => void
}

interface StatCardProps {
  icon: string
  iconColor: string
  title: string
  value: number | string
  subtitle: string
  tooltipTitle?: string
  tooltipItems?: TooltipItem[]
  tooltipEmptyMessage?: string
  onClick?: () => void
  warning?: boolean
}

export default function StatCard({
  icon,
  iconColor,
  title,
  value,
  subtitle,
  tooltipTitle,
  tooltipItems,
  tooltipEmptyMessage,
  onClick,
  warning
}: StatCardProps) {
  const [showTooltip, setShowTooltip] = useState(false)
  const [tooltipPosition, setTooltipPosition] = useState<'bottom' | 'top'>('bottom')
  const cardRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Adjust tooltip position if it would go off screen
  useEffect(() => {
    if (showTooltip && cardRef.current && tooltipRef.current) {
      const cardRect = cardRef.current.getBoundingClientRect()
      const tooltipHeight = tooltipRef.current.offsetHeight
      const spaceBelow = window.innerHeight - cardRect.bottom
      
      if (spaceBelow < tooltipHeight + 20) {
        setTooltipPosition('top')
      } else {
        setTooltipPosition('bottom')
      }
    }
  }, [showTooltip])

  const hasTooltip = tooltipItems && tooltipItems.length > 0

  return (
    <div 
      ref={cardRef}
      className={`${styles.statCard} ${onClick ? styles.clickable : ''} ${warning ? styles.warning : ''}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={onClick}
    >
      <div className={styles.statIcon} style={{ backgroundColor: iconColor }}>
        {icon}
      </div>
      <div className={styles.statContent}>
        <h3>{title}</h3>
        <p className={styles.statValue}>{value}</p>
        <span className={styles.statChange}>{subtitle}</span>
      </div>

      {/* Hover Tooltip */}
      {showTooltip && (tooltipTitle || hasTooltip || tooltipEmptyMessage) && (
        <div 
          ref={tooltipRef}
          className={`${styles.tooltip} ${styles[tooltipPosition]}`}
        >
          {tooltipTitle && <div className={styles.tooltipTitle}>{tooltipTitle}</div>}
          
          {hasTooltip ? (
            <div className={styles.tooltipList}>
              {tooltipItems.slice(0, 5).map((item, idx) => (
                <div 
                  key={idx} 
                  className={`${styles.tooltipItem} ${item.warning ? styles.tooltipWarning : ''}`}
                >
                  {item.color && (
                    <span 
                      className={styles.tooltipDot}
                      style={{ backgroundColor: item.color }}
                    />
                  )}
                  <div className={styles.tooltipItemContent}>
                    <span className={styles.tooltipLabel}>{item.label}</span>
                    {item.sublabel && (
                      <span className={styles.tooltipSublabel}>{item.sublabel}</span>
                    )}
                  </div>
                  {item.onAction && (
                    <button
                      type="button"
                      className={styles.tooltipAction}
                      onClick={(e) => { e.stopPropagation(); item.onAction!() }}
                    >
                      {item.actionLabel || 'Acknowledge'}
                    </button>
                  )}
                </div>
              ))}
              {tooltipItems.length > 5 && (
                <div className={styles.tooltipMore}>
                  +{tooltipItems.length - 5} more...
                </div>
              )}
            </div>
          ) : tooltipEmptyMessage ? (
            <div className={styles.tooltipEmpty}>{tooltipEmptyMessage}</div>
          ) : null}
          
          {onClick && (
            <div className={styles.tooltipHint}>Click for details</div>
          )}
        </div>
      )}
    </div>
  )
}
