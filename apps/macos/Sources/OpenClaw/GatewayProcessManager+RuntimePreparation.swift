import Foundation

extension GatewayProcessManager {
    func preparePersistentRuntimeAfterHealth() {
        guard !self.isTerminating, !self.runtimePreparationAttempted, self.runtimePreparationTask == nil
        else { return }
        self.runtimePreparationAttempted = true
        self.runtimePreparationTask = Task(priority: .background) { [weak self] in
            guard let self else { return }
            defer { self.runtimePreparationTask = nil }
            do {
                if (try? BundledRuntime.readySeed()) == nil {
                    self.appendLog("[gateway] preparing the persistent runtime in the background\n")
                    _ = try await BundledRuntime.seed()
                    try Task.checkCancellation()
                    self.appendLog("[gateway] persistent runtime is seeded and warmed\n")
                }
                try await BundledRuntime.garbageCollectAfterHealthy()
            } catch is CancellationError {
                // An incomplete warm is retried on the next launch, without changing CLI/service pins.
            } catch {
                let warning = "Background runtime preparation failed: \(error.localizedDescription). " +
                    "The current Gateway is still running; preparation will retry next launch."
                self.appendLog("[gateway] warning: \(warning)\n")
                self.logger.warning("\(warning, privacy: .public)")
            }
        }
    }
}
