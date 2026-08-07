const values = new Map<string, number>()

export const incrementMetric = (name: string, amount = 1) => values.set(name, (values.get(name) || 0) + amount)
export const observeMetric = (name: string, value: number) => values.set(name, (values.get(name) || 0) + value)
export const prometheusMetrics = () => [...values.entries()].map(([name, value]) => `${name} ${value}`).join('\n') + '\n'
