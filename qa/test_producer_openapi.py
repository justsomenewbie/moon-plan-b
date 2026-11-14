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
        self.full["security"] = [{"apiKey": []}]
        with self.assertRaisesRegex(ValueError, "/security"):
            self.check()

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
