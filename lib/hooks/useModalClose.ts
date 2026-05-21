import { useRef } from 'react'

/**
 * Hook for safer modal close behavior:
 * - B8: ignore mouse-drags that start inside the modal and end on the overlay
 *   (text-selection in a field that strays past the modal edge no longer closes)
 * - B9: if the form is dirty, confirm before closing
 *
 * Usage:
 *   const { overlayProps, modalProps, handleClose, formProps } = useModalClose(onClose)
 *   <div className="overlay" {...overlayProps}>
 *     <div className="modal" {...modalProps}>
 *       <form {...formProps} onSubmit={...}>
 */
export function useModalClose(onClose: () => void, confirmMessage = 'You have unsaved changes. Close without saving?') {
  const overlayMouseDownRef = useRef(false)
  const dirtyRef = useRef(false)

  const handleClose = () => {
    if (dirtyRef.current && !window.confirm(confirmMessage)) return
    onClose()
  }

  const overlayProps = {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
      overlayMouseDownRef.current = e.target === e.currentTarget
    },
    onMouseUp: (e: React.MouseEvent<HTMLDivElement>) => {
      if (overlayMouseDownRef.current && e.target === e.currentTarget) handleClose()
      overlayMouseDownRef.current = false
    },
  }

  const modalProps = {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
  }

  const formProps = {
    onChange: () => { dirtyRef.current = true },
  }

  const markClean = () => { dirtyRef.current = false }

  return { overlayProps, modalProps, formProps, handleClose, markClean, dirtyRef }
}
