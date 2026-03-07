import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        }
      : undefined,
});

export function issueLogger(issueId: string, issueIdentifier: string) {
  return logger.child({ issue_id: issueId, issue_identifier: issueIdentifier });
}

export function sessionLogger(issueId: string, issueIdentifier: string, sessionId: string) {
  return logger.child({ issue_id: issueId, issue_identifier: issueIdentifier, session_id: sessionId });
}
