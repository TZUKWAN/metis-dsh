import importlib.util
import pathlib
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / 'scripts' / 'electron-layout-acceptance.py'
SPEC = importlib.util.spec_from_file_location('electron_layout_acceptance', SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f'Could not load acceptance module: {SCRIPT_PATH}')
acceptance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acceptance)


class CurrentEntryContractTests(unittest.TestCase):
    def test_surfaces_are_the_current_product_entry_order(self) -> None:
        self.assertEqual(
            acceptance.SURFACE_ORDER,
            ('converse', 'projects', 'outcomes', 'scenes'),
        )
        self.assertEqual(
            [acceptance.SURFACE_CONTRACT[name]['navId'] for name in acceptance.SURFACE_ORDER],
            ['converse', 'projects', 'outcomes', 'personalization'],
        )

    def test_projects_contract_uses_the_stable_page_test_id(self) -> None:
        projects = acceptance.SURFACE_CONTRACT['projects']
        self.assertEqual(projects['rootSelector'], '.projects-page')
        self.assertEqual(projects['requiredTestId'], 'projects-page')
        self.assertIn('[data-testid="projects-page"]', projects['requiredSelectors'])

    def test_outcomes_and_scenes_contracts_use_current_landmarks(self) -> None:
        outcomes = acceptance.SURFACE_CONTRACT['outcomes']
        scenes = acceptance.SURFACE_CONTRACT['scenes']
        self.assertEqual(outcomes['rootSelector'], '.outcomes-page, .outcomes-empty')
        self.assertEqual(scenes['entry'], 'personalization')
        self.assertEqual(scenes['requiredTestId'], 'scenario-workbench')
        self.assertIn('[data-testid="scenario-workbench"]', scenes['requiredSelectors'])

    def test_old_workbench_and_visual_matrices_are_not_current_gates(self) -> None:
        script = SCRIPT_PATH.read_text(encoding='utf-8')
        self.assertNotIn("document.querySelector('.project-shell')", script)
        self.assertNotIn("document.querySelector('.topbar-nav__item[data-nav-id=\"write\"]')", script)
        self.assertEqual(acceptance.OUT_OF_SCOPE, {
            'rendererResponsiveMatrix': False,
            'windowsNativeWindowMatrix': False,
            'safeMarkdownSecurity': False,
            'pixelRegression': False,
        })

    def test_product_sources_still_expose_the_contract_landmarks(self) -> None:
        projects_source = (PROJECT_ROOT / 'src' / 'pages' / 'ProjectsPage.tsx').read_text(encoding='utf-8')
        outcomes_source = (PROJECT_ROOT / 'src' / 'pages' / 'OutcomesPage.tsx').read_text(encoding='utf-8')
        scenes_source = (PROJECT_ROOT / 'src' / 'personalization' / 'ScenarioWorkbench.tsx').read_text(encoding='utf-8')
        self.assertIn('data-testid="projects-page"', projects_source)
        self.assertIn('className="outcomes-page"', outcomes_source)
        self.assertIn('className="outcomes-empty"', outcomes_source)
        self.assertIn('data-testid="scenario-workbench"', scenes_source)


if __name__ == '__main__':
    unittest.main()
