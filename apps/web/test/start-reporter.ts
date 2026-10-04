// Diagnostic only: prints every test file and test case as it starts, with a timestamp.
const stamp = () => new Date().toISOString().slice(11, 23);
export default class StartReporter {
  onTestModuleStart(module: { moduleId: string }) {
    console.warn(`[start-file ${stamp()}] ${module.moduleId}`);
  }
  onTestModuleEnd(module: { moduleId: string }) {
    console.warn(`[end-file ${stamp()}] ${module.moduleId}`);
  }
  onTestCaseReady(test: { module: { moduleId: string }; fullName: string }) {
    console.warn(`[start-test ${stamp()}] ${test.module.moduleId} > ${test.fullName}`);
  }
}
