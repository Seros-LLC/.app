import { TrackerWriter, TrackerWriteResult } from './interface';

/**
 * Fake tracker writer for development and testing.
 * Logs the write operation but doesn't actually write to any external system.
 */
export class FakeTrackerWriter implements TrackerWriter {
  private readonly name: string;

  constructor(name: string = 'fake-tracker') {
    this.name = name;
  }

  getName(): string {
    return this.name;
  }

  async write(confirmationId: string): Promise<void> {
    // Simulate some async work (like network call)
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Log the write (in real implementation, this would be an actual API call)
    console.log(`[${this.name}] Writing confirmation ${confirmationId} to external tracker`);
    
    // In a real implementation, we might return a tracker ID
    // For fake, we just resolve successfully
    return;
  }

  async isReady(): Promise<boolean> {
    // Fake tracker is always ready
    return true;
  }
}

/**
 * Result helper for tracker writes
 */
export function createTrackerWriteResult(
  success: boolean,
  trackerId?: string,
  error?: string
): TrackerWriteResult {
  // exactOptionalPropertyTypes: an absent optional field is not the same as one
  // present and undefined, so only set the keys we actually have.
  const result: TrackerWriteResult = { success };
  if (trackerId !== undefined) result.trackerId = trackerId;
  if (error !== undefined) result.error = error;
  return result;
}