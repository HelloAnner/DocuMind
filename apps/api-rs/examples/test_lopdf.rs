use std::fs;

fn main() -> anyhow::Result<()> {
    let input = "/tmp/doc-full.pdf";
    let bytes = fs::read(input)?;
    let mut doc = lopdf::Document::load_mem(&bytes)?;
    let pages = doc.get_pages();
    let target = 33u32;
    let target_id = *pages.get(&target).unwrap();
    let catalog = doc.catalog()?.clone();
    let root_pages_ref = catalog.get(b"Pages")?.as_reference()?;
    
    for (num, id) in pages.iter() {
        if *num != target {
            doc.delete_object(*id);
        }
    }
    
    let intermediate_pages: Vec<lopdf::ObjectId> = doc.objects.iter()
        .filter(|(id, _)| **id != root_pages_ref)
        .filter_map(|(id, obj)| {
            if let Ok(dict) = obj.as_dict() {
                if dict.get(b"Type").ok()?.as_name().ok() == Some(b"Pages") {
                    return Some(*id);
                }
            }
            None
        })
        .collect();
    for id in intermediate_pages {
        doc.delete_object(id);
    }
    
    if let Ok(root_pages) = doc.get_object_mut(root_pages_ref)?.as_dict_mut() {
        root_pages.set("Kids", lopdf::Object::Array(vec![lopdf::Object::Reference(target_id)]));
        root_pages.set("Count", lopdf::Object::Integer(1));
    }
    if let Ok(page_obj) = doc.get_object_mut(target_id)?.as_dict_mut() {
        page_obj.set("Parent", lopdf::Object::Reference(root_pages_ref));
    }
    
    doc.prune_objects();
    doc.renumber_objects();
    doc.compress();
    
    let text = doc.extract_text(&[1])?;
    println!("extracted text from sliced page 1 (first 500 chars):");
    println!("{}", &text[..text.len().min(500)]);
    
    let mut output = Vec::new();
    doc.save_to(&mut output)?;
    fs::write("/tmp/page33-manual.pdf", &output)?;
    println!("saved");
    Ok(())
}
