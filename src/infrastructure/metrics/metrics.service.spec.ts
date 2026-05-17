import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('renders Prometheus-safe metric names and escaped label values', () => {
    const service = new MetricsService();

    service.increment('http.requests.total', {
      'route.path': '/users/"quoted"',
      line: 'first\nsecond',
      slash: 'a\\b',
    });

    expect(service.render()).toContain(
      'http_requests_total{route_path="/users/\\"quoted\\"",line="first\\nsecond",slash="a\\\\b"} 1',
    );
  });

  it('renders histograms with Prometheus bucket, sum, and count series', () => {
    const service = new MetricsService();

    service.histogram('http.duration_ms', 120, { route: '/users' });
    service.histogram('http.duration_ms', 600, { route: '/users' });

    const output = service.render();

    expect(output).toContain('# TYPE http_duration_ms histogram');
    expect(output).toContain(
      'http_duration_ms_bucket{route="/users",le="250"} 1',
    );
    expect(output).toContain(
      'http_duration_ms_bucket{route="/users",le="1000"} 2',
    );
    expect(output).toContain(
      'http_duration_ms_bucket{route="/users",le="+Inf"} 2',
    );
    expect(output).toContain('http_duration_ms_sum{route="/users"} 720');
    expect(output).toContain('http_duration_ms_count{route="/users"} 2');
    expect(output).not.toContain('http_duration_ms_min');
    expect(output).not.toContain('http_duration_ms_avg');
  });
});
