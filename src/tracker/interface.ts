/**
 * Tracker writer interface for external integrations (Slack, Jira, Linear, etc.)
 * 
 * This abstraction allows different tracker implementations to be plugged in
 * while maintaining the core confirmation -> task creation flow.
 */
export interface TrackerWriter {
  /**
   * Write a confirmed task to the external tracker
   * @param confirmationId The confirmation ID that was confirmed
   * @returns Promise that resolves when the write is complete
   */
  write(confirmationId: string): Promise<void>;
  
  /**
   * Optional: Check if the writer is configured and ready
   * @returns Promise that resolves to true if ready
   */
  isReady?(): Promise<boolean>;
  
  /**
   * Optional: Get the name of the tracker for logging/metrics
   */
  getName(): string;
}

/**
 * Result of a tracker write operation
 */
export interface TrackerWriteResult {
  success: boolean;
  trackerId?: string; // External tracker ID if successful
  error?: string; // Error message if failed
}