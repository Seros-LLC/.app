import { FakeTrackerWriter } from './fake';
import { TrackerWriter } from './interface';

/**
 * Tracker service that provides access to the configured tracker writer.
 * In production, this would be configured based on environment variables.
 */
export class TrackerService {
  private static instance: TrackerService;
  private writer: TrackerWriter;

  private constructor() {
    // Default to fake tracker for development
    this.writer = new FakeTrackerWriter();
  }

  static getInstance(): TrackerService {
    if (!TrackerService.instance) {
      TrackerService.instance = new TrackerService();
    }
    return TrackerService.instance;
  }

  getWriter(): TrackerWriter {
    return this.writer;
  }

  setWriter(writer: TrackerWriter) {
    this.writer = writer;
  }
}