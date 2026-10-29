import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claimLongformRecognitionLeaseV1 } from "./longformRecognitionLeaseV1";

it("admits one acoustic writer per resolved cache and releases it idempotently",()=>{
  const root=join("D:/owned-longform-lease",randomUUID()),release=claimLongformRecognitionLeaseV1(root);
  try{expect(()=>claimLongformRecognitionLeaseV1(join(root,"child/.."))).toThrow("LONGFORM_RECOGNITION_ALREADY_RUNNING");}
  finally{release();}
  const next=claimLongformRecognitionLeaseV1(root);release();
  try{expect(()=>claimLongformRecognitionLeaseV1(root)).toThrow("LONGFORM_RECOGNITION_ALREADY_RUNNING");}
  finally{next();}
});
it("allows independent caches and treats Windows path casing as the same cache",()=>{
  const root=join("D:/owned-longform-lease",randomUUID()),release=claimLongformRecognitionLeaseV1(root),other=claimLongformRecognitionLeaseV1(root+"-other");
  try{if(process.platform==="win32")expect(()=>claimLongformRecognitionLeaseV1(root.toUpperCase())).toThrow("LONGFORM_RECOGNITION_ALREADY_RUNNING");}
  finally{release();other();}
});
