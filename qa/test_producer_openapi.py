"""Offline drift checks for the frontend subset of the producer OpenAPI file."""
import json
import unittest

from qa.check_producer_openapi import EXTRACT, compare, scoped_contract


class ProducerOpenAPITest(unittest.TestCase):
    def setUp(self):
        self.tracked = json.loads(EXTRACT.read_text(encoding="utf-8"))
        self.full = json.loads(EXTRACT.read_text(encoding="utf-8"))

    def check(self):
        compare(self.tracked, scoped_contract(self.full, self.tracked))

    def test_unrelated_routes_methods_schemas_and_four_private_examples(self):
        self.full["paths"]["/new"] = {"get": {"operationId": "new"}}
        self.full["paths"]["/api/v1/jobs/{job_id}"]["head"] = {"operationId": "inspectHeaders"}
        schemas = self.full["components"]["schemas"]
        schemas["Unused"] = {"type": "string"}
        for name in ("CreateJobRequest", "Job", "JobAccepted", "Problem"):
            schemas[name]["examples"] = [{"test": True}]
        self.check()

    def test_operation_changes_are_detected(self):
        del self.full["paths"]["/api/v1/jobs"]["post"]["responses"]["200"]
        with self.assertRaisesRegex(ValueError, r"/api/v1/jobs/post/responses/200"):
            self.check()

    def test_new_path_parameters_are_detected(self):
        self.full["paths"]["/api/v1/jobs"]["parameters"] = []
        with self.assertRaisesRegex(ValueError, r"/api/v1/jobs/parameters"):
            self.check()

    def test_inherited_security_change_is_detected(self):
        self.full["security"] = []
        with self.assertRaisesRegex(ValueError, "/security"):
            self.check()

    def test_scheme_declarations_follow_effective_security(self):
        local = {"type": "http", "scheme": "bearer"}
        self.full["components"]["securitySchemes"].update(Local=local, Unused=local)
        path = "/api/v1/jobs"
        operation = self.full["paths"][path]["post"]
        operation["security"] = [{"Local": []}, {}]
        subset = scoped_contract(self.full, {"paths": {path: {"post": {}}}})
        self.assertNotIn("security", subset)
        self.assertEqual(subset["components"]["securitySchemes"], {"Local": local})
        operation["security"] = []
        public = scoped_contract(self.full, {"paths": {path: {"post": {}}}})
        self.assertNotIn("securitySchemes", public["components"])
        del operation["security"]
        inherited = scoped_contract(self.full, {"paths": {path: {"post": {}}}})
        self.assertEqual(inherited["security"], [{"ApiKeyAuth": []}])
        self.assertEqual(inherited["components"]["securitySchemes"], {
            "ApiKeyAuth": self.full["components"]["securitySchemes"]["ApiKeyAuth"]
        })

    def test_undefined_inherited_scheme_is_rejected(self):
        del self.full["components"]["securitySchemes"]["ApiKeyAuth"]
        with self.assertRaisesRegex(ValueError, "unresolved producer component: securitySchemes/ApiKeyAuth"):
            self.check()

    def test_tracked_extract_matches_the_producer_in_this_checkout(self):
        owner = EXTRACT.parent.parent / "lunar-navigator/backend/contract/openapi.json"
        compare(self.tracked, scoped_contract(json.loads(owner.read_bytes()), self.tracked))

    def test_skipping_a_scoped_method_is_detected(self):
        del self.full["paths"]["/api/v1/jobs"]["post"]
        with self.assertRaisesRegex(ValueError, "missing producer operation: POST /api/v1/jobs"):
            self.check()

    def test_new_tracked_operation_is_compared_without_changing_the_checker(self):
        path = "/api/v1/additional"
        self.tracked["paths"][path] = {"get": {"operationId": "additional"}}
        self.full["paths"][path] = {"get": {"operationId": "additional"}}
        self.check()
        self.full["paths"][path]["get"]["operationId"] = "changed"
        with self.assertRaisesRegex(ValueError, "additional/get/operationId"):
            self.check()

    def test_drift_in_transitive_job_request_is_detected(self):
        self.full["components"]["schemas"]["AltDatesPythonJobRequest"]["properties"]["type"]["const"] = "new"
        with self.assertRaisesRegex(ValueError, "AltDatesPythonJobRequest/properties/type/const"):
            self.check()

    def test_examples_outside_the_four_omissions_remain_checked(self):
        self.full["components"]["schemas"]["AltDatesRequest"]["examples"] = [{}]
        with self.assertRaisesRegex(ValueError, "AltDatesRequest/examples"):
            self.check()

    def test_unresolved_reference_is_rejected(self):
        del self.full["components"]["schemas"]["JobAccepted"]
        with self.assertRaisesRegex(ValueError, "unresolved producer component: schemas/JobAccepted"):
            self.check()


if __name__ == "__main__":
    unittest.main()
