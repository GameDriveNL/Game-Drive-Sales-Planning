'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import styles from './ChatBot.module.css'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

const SUGGESTIONS = [
  'How many active sales are running right now?',
  'Which clients have the most coverage items?',
  'What platforms have the longest cooldowns?',
  'Show me top-performing coverage outlets',
]

export default function ChatBot() {
  const { profile, loading } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // Focus textarea when panel opens
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isOpen])

  // Auto-resize textarea
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 100)}px`
  }

  const sendMessage = async (text?: string) => {
    const messageText = (text || input).trim()
    if (!messageText || isStreaming) return

    const userMessage: ChatMessage = { role: 'user', content: messageText }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')
    setIsStreaming(true)

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Create abort controller for this request
    const controller = new AbortController()
    abortRef.current = controller

    // Add placeholder assistant message
    const assistantMessage: ChatMessage = { role: 'assistant', content: '' }
    setMessages([...newMessages, assistantMessage])

    try {
      const response = await fetch('/api/chatbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: messageText,
          history: newMessages.slice(-10),
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error((errData as Record<string, string>).error || `HTTP ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response stream')

      const decoder = new TextDecoder()
      let assistantText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') break

            try {
              const parsed = JSON.parse(data)
              if (parsed.error) {
                throw new Error(parsed.error)
              }
              if (parsed.text) {
                assistantText += parsed.text
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: assistantText,
                  }
                  return updated
                })
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue
              throw e
            }
          }
        }
      }

      // If no text came through, show a fallback
      if (!assistantText) {
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            role: 'assistant',
            content: 'I received your question but couldn\'t generate a response. Please try again.',
            error: true,
          }
          return updated
        })
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return

      const errorMsg = err instanceof Error ? err.message : 'Something went wrong'
      setMessages(prev => {
        const updated = [...prev]
        if (updated.length > 0 && updated[updated.length - 1].role === 'assistant') {
          updated[updated.length - 1] = {
            role: 'assistant',
            content: errorMsg,
            error: true,
          }
        } else {
          updated.push({ role: 'assistant', content: errorMsg, error: true })
        }
        return updated
      })
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleClose = () => {
    // Abort any in-flight request
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsStreaming(false)
    setIsOpen(false)
  }

  const handleToggle = () => {
    if (isOpen) {
      handleClose()
    } else {
      setIsOpen(true)
    }
  }

  // Don't render for unauthenticated users or while loading
  if (loading || !profile) return null

  return (
    <>
      {/* Chat panel */}
      {isOpen && (
        <div className={styles.panel}>
          {/* Header */}
          <div className={styles.header}>
            <div className={styles.headerTitle}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              GameDrive AI
            </div>
            <button className={styles.closeButton} onClick={handleClose} title="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className={styles.messages}>
            {messages.length === 0 ? (
              <div className={styles.emptyState}>
                <svg className={styles.emptyIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <h3>Ask anything about your data</h3>
                <p>I can look up sales, coverage, clients, platforms, and more.</p>
                <div className={styles.suggestions}>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className={styles.suggestionButton}
                      onClick={() => sendMessage(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={
                      msg.error
                        ? styles.errorBubble
                        : msg.role === 'user'
                        ? styles.userBubble
                        : styles.assistantBubble
                    }
                  >
                    {msg.content}
                    {msg.role === 'assistant' && isStreaming && i === messages.length - 1 && !msg.error && (
                      <span className={styles.streamingDot} />
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input */}
          <div className={styles.inputArea}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your data..."
              rows={1}
              disabled={isStreaming}
            />
            <button
              className={styles.sendButton}
              onClick={() => sendMessage()}
              disabled={!input.trim() || isStreaming}
              title="Send message"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Floating button */}
      <button className={styles.floatingButton} onClick={handleToggle} title="Chat with AI">
        {isOpen ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>
    </>
  )
}
